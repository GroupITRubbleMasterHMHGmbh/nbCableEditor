from types import SimpleNamespace

from core.models import ObjectType
from dcim.choices import (
    CableTypeChoices, InterfaceDuplexChoices, InterfaceModeChoices, InterfacePoEModeChoices, InterfacePoETypeChoices,
    InterfaceTypeChoices, PortTypeChoices,
)
from dcim.models import (
    Cable, Device, DeviceRole, DeviceType, FrontPort, FrontPortTemplate, Interface, InterfaceTemplate, Location, Manufacturer,
    PortMapping, Rack, RearPort, RearPortTemplate, Site, VirtualChassis,
)
from django.core.exceptions import ValidationError
from django.urls import reverse
from extras.choices import CustomFieldUIVisibleChoices
from extras.models import CustomField, JournalEntry, Tag
from ipam.models import VLAN
from users.models import ObjectPermission
from utilities.testing import TestCase

from nbcableeditor.configuration import cable_custom_values
from nbcableeditor.models import CableEditorSettings, PortPlacement, RackCableShare
from nbcableeditor.rack_features import TRACE_DESTINATION_FEATURES


class RackLayoutTestCase(TestCase):
    user_permissions = (
        "dcim.view_devicetype", "dcim.view_interfacetemplate",
        "dcim.view_rack", "dcim.view_device", "dcim.view_interface", "dcim.view_cable",
        "dcim.view_frontport", "dcim.view_rearport",
    )

    @classmethod
    def setUpTestData(cls):
        site = Site.objects.create(name="Layout Test Site", slug="layout-test-site")
        manufacturer = Manufacturer.objects.create(name="Layout Manufacturer", slug="layout-manufacturer")
        cls.device_type = DeviceType.objects.create(
            manufacturer=manufacturer, model="Panel 48", slug="panel-48",
            front_image="devicetype-images/front.png", rear_image="devicetype-images/rear.png",
        )
        other_type = DeviceType.objects.create(manufacturer=manufacturer, model="Other Panel", slug="other-panel")
        cls.first, cls.last, cls.foreign = [
            InterfaceTemplate.objects.create(
                device_type=device_type, name=name, type=InterfaceTypeChoices.TYPE_1GE_FIXED,
            )
            for device_type, name in ((cls.device_type, "Ethernet2"), (cls.device_type, "Ethernet10"),
                                      (other_type, "Ethernet2"))
        ]
        role = DeviceRole.objects.create(name="Layout Role", slug="layout-role")
        cls.rack = Rack.objects.create(site=site, name="Main rack", starting_unit=2)
        cls.other_rack = Rack.objects.create(site=site, name="Other rack")
        cls.device, cls.peer, cls.external = [
            Device.objects.create(
                device_type=cls.device_type, role=role, site=site, rack=rack,
                name=name, position=position, face="front",
            )
            for rack, name, position in ((cls.rack, "Switch A", 3.5), (cls.rack, "Switch B", 5),
                                          (cls.other_rack, "Hidden external device", 1))
        ]

    def route(self, name, obj=None):
        return reverse(f"plugins:nbcableeditor:{name}", args=[(obj or self.device_type).pk])

    def save(self, revision, *placements):
        return self.client.post(
            self.route("placements"), {"revision": revision, "placements": placements}, content_type="application/json",
        )

    def point(self, template=None, face="front", x=0.2, y=0.7):
        return {"port_id": (template or self.first).pk, "face": face, "x": x, "y": y}

    def restrict_view(self, model, constraints):
        self.remove_permissions(f"{model._meta.app_label}.view_{model._meta.model_name}")
        permission = ObjectPermission.objects.create(
            name=f"Restricted {model._meta.model_name} view", actions=["view"], constraints=constraints,
        )
        permission.object_types.add(ObjectType.objects.get_for_model(model))
        permission.users.add(self.user)

    def test_batch_layout_reused_on_devices_and_stale_save_rejected(self):
        self.add_permissions("dcim.change_devicetype")
        response = self.client.get(self.route("layout"))
        data = response.context["layout_data"]
        self.assertEqual([row["name"] for row in data["ports"]], ["Ethernet2", "Ethernet10"])
        self.assertTrue(data["frontImage"].endswith("/front.png"))

        placed = self.save(0, self.point(), self.point(self.last, face="rear", x=0.9))
        self.assertEqual(placed.status_code, 200, placed.content)
        self.assertEqual(placed.json(), {"revision": 1})
        self.assertEqual(self.save(0).status_code, 409)

        response = self.client.get(self.route("rack", self.rack))
        rack = response.context["rack_data"]
        self.assertEqual(rack["startingUnit"], 2)
        self.assertEqual([row["position"] for row in rack["devices"]], [3.5, 5.0])
        for device in rack["devices"]:
            ports = {port["name"]: port for port in device["ports"]}
            self.assertFalse(device["missingLayout"])
            self.assertEqual((ports["Ethernet2"]["face"], ports["Ethernet2"]["x"]), ("front", 0.2))
            self.assertEqual((ports["Ethernet10"]["face"], ports["Ethernet10"]["x"]), ("rear", 0.9))
            self.assertTrue(device["rearImage"].endswith("/rear.png"))
        self.assertEqual(self.save(1).json(), {"revision": 2})
        self.assertFalse(PortPlacement.objects.exists())
        devices = self.client.get(self.route("rack", self.rack)).context["rack_data"]["devices"]
        self.assertTrue(all(device["missingLayout"] for device in devices))

    def test_type_images_without_layout_do_not_supply_port_coordinates(self):
        devices = self.client.get(self.route("rack", self.rack)).context["rack_data"]["devices"]
        self.assertEqual(len(devices), 2)
        for device in devices:
            self.assertTrue(device["frontImage"].endswith("/front.png"))
            self.assertTrue(device["missingLayout"])
            self.assertTrue(all(port["x"] is None and port["y"] is None for port in device["ports"]))

    def test_bad_batch_leaves_layout_unchanged(self):
        self.add_permissions("dcim.change_devicetype")
        self.assertEqual(self.save(0, self.point()).status_code, 200)
        for placements in ((self.point(self.foreign),), (self.point(x=1.1),), (self.point(), self.point())):
            with self.subTest(placements=placements):
                self.assertEqual(self.save(1, *placements).status_code, 400)
                self.assertEqual(PortPlacement.objects.get().x, 0.2)

    def test_read_only_and_object_restricted_layout(self):
        self.assertFalse(self.client.get(self.route("layout")).context["layout_data"]["canEdit"])
        self.assertEqual(self.save(0, self.point()).status_code, 403)
        self.add_permissions("dcim.change_devicetype")
        self.assertEqual(self.save(0, self.point(), self.point(self.last)).status_code, 200)
        self.remove_permissions("dcim.view_interfacetemplate")
        permission = ObjectPermission.objects.create(
            name="First template only", actions=["view"], constraints={"pk": self.first.pk},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(InterfaceTemplate))
        permission.users.add(self.user)
        self.assertEqual(self.save(1).status_code, 200)
        self.assertEqual(PortPlacement.objects.get().interface_template_id, self.last.pk)

    def test_rack_does_not_project_restricted_type_images_or_template_placements(self):
        Device.objects.filter(pk=self.device.pk).update(name=None)
        PortPlacement.objects.create(interface_template=self.first, face="front", x=.2, y=.5)
        PortPlacement.objects.create(interface_template=self.last, face="front", x=.7, y=.5, label="Private layout label")
        self.restrict_view(InterfaceTemplate, {"pk": self.first.pk})
        url = self.route("rack", self.rack)

        def get_device():
            rack_data = self.client.get(url).context["rack_data"]
            return next(device for device in rack_data["devices"] if device["id"] == self.device.pk)

        device = get_device()
        self.assertEqual(device["name"], f"{self.device_type.model} ({self.device.pk})")
        self.assertTrue(device["frontImage"].endswith("/front.png"))
        ports = {port["name"]: port for port in device["ports"]}
        self.assertEqual(ports[self.first.name]["x"], .2)
        self.assertIsNone(ports[self.last.name]["x"])
        self.assertNotIn("layoutLabel", ports[self.last.name])
        self.assertFalse(device["missingLayout"])

        PortPlacement.objects.filter(interface_template=self.first).delete()
        device = get_device()
        self.assertFalse(device["missingLayout"])
        self.assertTrue(all(port["x"] is None for port in device["ports"]))

        self.restrict_view(DeviceType, {"pk": self.foreign.device_type_id})
        device = get_device()
        self.assertEqual(device["name"], f"Device ({self.device.pk})")
        self.assertIsNone(device["deviceType"])
        self.assertIsNone(device["layoutUrl"])
        self.assertIsNone(device["frontImage"])
        self.assertIsNone(device["rearImage"])
        self.assertFalse(device["missingLayout"])
        self.assertTrue(all(port["x"] is None for port in device["ports"]))

    def test_rack_and_remote_endpoint_redact_hidden_virtual_chassis(self):
        chassis = VirtualChassis.objects.create(name="Private chassis")
        Device.objects.filter(pk=self.device.pk).update(name=None, virtual_chassis=chassis, vc_position=1)
        Device.objects.filter(pk=self.external.pk).update(name=None, virtual_chassis=chassis, vc_position=2)
        local = Interface.objects.get(device=self.device, name=self.first.name)
        remote = Interface.objects.get(device=self.external, name=self.first.name)
        Cable.objects.create(a_terminations=[local], b_terminations=[remote])
        url = self.route("rack", self.rack)

        self.add_permissions("dcim.view_virtualchassis")
        data = self.client.get(url).context["rack_data"]
        self.assertIn("Private chassis:1", {device["name"] for device in data["devices"]})
        self.assertEqual(data["cables"][0]["endpointB"]["deviceName"], "Private chassis:2")

        self.remove_permissions("dcim.view_virtualchassis")
        response = self.client.get(url)
        self.assertNotContains(response, chassis.name)
        self.assertEqual(response.context["rack_data"]["cables"][0]["endpointB"]["deviceName"], "Unnamed device")

    def test_cable_object_custom_field_avoids_related_names_in_device_label(self):
        Device.objects.filter(pk=self.device.pk).update(name=None)
        cable = SimpleNamespace(pk=1, custom_field_data={"related_device": self.device.pk})
        field = CustomField(
            name="related_device", type="object", related_object_type=ObjectType.objects.get_for_model(Device),
        )
        self.remove_permissions("dcim.view_devicetype")
        self.assertEqual(cable_custom_values(self.user, [cable], [field]), {
            1: {"related_device": f"Device {self.device.pk}"},
        })

    def test_rack_payload_redacts_endpoints_and_cables_by_permission(self):
        self.add_permissions("dcim.change_cable", "dcim.delete_cable")
        first = Interface.objects.get(device=self.device, name=self.first.name)
        internal = Interface.objects.get(device=self.peer, name=self.first.name)
        external = Interface.objects.get(device=self.external, name=self.first.name)
        other = Interface.objects.get(device=self.device, name=self.last.name)
        internal_cable = Cable.objects.create(
            a_terminations=[first], b_terminations=[internal],
            type=CableTypeChoices.TYPE_CAT6, color="0099cc", label="Lab uplink",
            description="Connects the two switches.",
        )
        external_cable = Cable.objects.create(a_terminations=[other], b_terminations=[external])

        response = self.client.get(self.route("rack", self.rack))
        cables = {cable["id"]: cable for cable in response.context["rack_data"]["cables"]}
        self.assertTrue(cables[internal_cable.pk]["editable"])
        self.assertTrue(cables[internal_cable.pk]["deletable"])
        self.assertEqual(cables[internal_cable.pk]["type"], "CAT6")
        self.assertEqual(cables[internal_cable.pk]["typeValue"], "cat6")
        self.assertEqual(cables[internal_cable.pk]["statusValue"], "connected")
        self.assertEqual(cables[internal_cable.pk]["color"], "0099cc")
        self.assertEqual(cables[internal_cable.pk]["label"], "Lab uplink")
        self.assertEqual(cables[internal_cable.pk]["description"], "Connects the two switches.")
        self.assertIsNone(cables[internal_cable.pk]["traceA"])
        self.assertIsNone(cables[internal_cable.pk]["traceB"])
        self.assertIn({"value": "cat6", "label": "CAT6"}, response.context["rack_data"]["cableTypes"])
        self.assertIn({"value": "planned", "label": "Planned"}, response.context["rack_data"]["cableStatuses"])
        local_ports = {
            port["id"]: port for device in response.context["rack_data"]["devices"] for port in device["ports"]
        }
        self.assertEqual(local_ports[first.pk]["url"], first.get_absolute_url())
        self.assertFalse(cables[external_cable.pk]["deletable"])
        self.assertFalse(cables[external_cable.pk]["editable"])
        self.assertIsNone(cables[external_cable.pk]["b"])
        self.assertIsNone(cables[external_cable.pk]["traceB"])
        self.assertIsNone(cables[external_cable.pk]["endpointA"])
        self.assertEqual(cables[external_cable.pk]["endpointB"]["deviceName"], self.external.name)

        self.restrict_view(Device, {"rack_id": self.rack.pk})
        response = self.client.get(self.route("rack", self.rack))
        restricted = next(cable for cable in response.context["rack_data"]["cables"] if cable["id"] == external_cable.pk)
        self.assertIsNone(restricted["endpointB"])
        self.assertNotContains(response, self.external.name)

        JournalEntry.objects.create(assigned_object=internal_cable, comments="Preserve this entry")
        response = self.client.get(self.route("rack", self.rack))
        protected = next(cable for cable in response.context["rack_data"]["cables"] if cable["id"] == internal_cable.pk)
        self.assertFalse(protected["deletable"])
        self.assertTrue(protected["editable"])

    def test_cable_link_preserves_view_and_requires_readable_rack_and_cable(self):
        first = Interface.objects.get(device=self.device, name=self.first.name)
        peer = Interface.objects.get(device=self.peer, name=self.first.name)
        cable = Cable.objects.create(a_terminations=[first], b_terminations=[peer])
        endpoint = self.route("cable-links", self.rack)
        payload = {"cableId": cable.pk, "settings": {"display": {"lines": "filtered"}, "portFilterAction": "mark"}}
        response = self.client.post(endpoint, payload, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        url = response.json()["url"]
        self.assertEqual(self.client.post(endpoint, payload, content_type="application/json").json()["url"], url)
        self.assertEqual(RackCableShare.objects.count(), 1)
        shared = self.client.get(url).context["rack_data"]["sharedCableView"]
        self.assertEqual(shared["cableId"], cable.pk)
        self.assertEqual(shared["settings"]["display"]["lines"], "filtered")
        self.assertEqual(shared["settings"]["portFilterAction"], "mark")
        other_rack = self.route("cable-links", self.other_rack)
        self.assertEqual(self.client.post(other_rack, payload, content_type="application/json").status_code, 404)

        self.remove_permissions("dcim.view_cable")
        rack_data = self.client.get(url).context["rack_data"]
        self.assertIsNone(rack_data["sharedCableView"])
        self.assertTrue(rack_data["cableShareUnavailable"])
        self.assertEqual(self.client.post(endpoint, payload, content_type="application/json").status_code, 404)

        self.remove_permissions("dcim.view_cable")
        data = self.client.get(self.route("rack", self.rack)).context["rack_data"]
        self.assertEqual(data["cables"], [])
        ports = {port["id"]: port for device in data["devices"] for port in device["ports"]}
        self.assertIsNone(ports[first.pk]["cableId"])
        self.assertTrue(ports[first.pk]["blocked"])
        self.assertEqual(ports[first.pk]["occupancy"], "cabled")

    def test_vlan_fields_respect_object_permissions(self):
        native = VLAN.objects.create(vid=10, name="Management", custom_field_data={"editorColorHex": "#16a34a"})
        visible = VLAN.objects.create(vid=20, name="Voice", custom_field_data={"editorColorHex": "red"})
        restricted = VLAN.objects.create(vid=30, name="Restricted VLAN", custom_field_data={"editorColorHex": "#ff0000"})
        visible_high = VLAN.objects.create(vid=40, name="Guest")
        first = Interface.objects.get(device=self.device, name=self.first.name)
        last = Interface.objects.get(device=self.device, name=self.last.name)
        first.mode = InterfaceModeChoices.MODE_TAGGED
        first.poe_mode = InterfacePoEModeChoices.MODE_PSE
        first.poe_type = InterfacePoETypeChoices.TYPE_2_8023AT
        first.untagged_vlan = native
        first.description = "Access switch uplink"
        first.speed = 1_000_000
        first.duplex = InterfaceDuplexChoices.DUPLEX_FULL
        first.mtu = 9000
        first.mgmt_only = True
        first.save()
        first.tagged_vlans.add(restricted, visible_high, visible)
        last.mode = InterfaceModeChoices.MODE_ACCESS
        last.untagged_vlan = restricted
        last.save()

        def get_ports():
            data = self.client.get(self.route("rack", self.rack)).context["rack_data"]
            return {port["id"]: port for device in data["devices"] for port in device["ports"]}

        ports = get_ports()
        self.assertEqual(ports[first.pk]["vlanMode"], InterfaceModeChoices.MODE_TAGGED)
        self.assertEqual(ports[first.pk]["description"], first.description)
        self.assertEqual(ports[first.pk]["type"], first.get_type_display())
        self.assertEqual(ports[first.pk]["poeMode"], first.get_poe_mode_display())
        self.assertEqual(ports[first.pk]["poeType"], first.get_poe_type_display())
        self.assertEqual(ports[first.pk]["vlanModeDisplay"], first.get_mode_display())
        self.assertEqual(ports[first.pk]["speedKbps"], 1_000_000)
        self.assertEqual(ports[first.pk]["duplex"], first.get_duplex_display())
        self.assertEqual(ports[first.pk]["mtu"], 9000)
        self.assertTrue(ports[first.pk]["managementOnly"])
        self.assertIsNone(ports[first.pk]["untaggedVlan"])
        self.assertEqual(ports[first.pk]["taggedVlans"], [])

        self.restrict_view(VLAN, {"pk__in": [native.pk, visible.pk, visible_high.pk]})
        ports = get_ports()
        self.assertEqual(ports[first.pk]["untaggedVlan"], {"vid": 10, "name": "Management", "color": "#16A34A"})
        self.assertEqual(
            ports[first.pk]["taggedVlans"], [{"vid": 20, "name": "Voice"}, {"vid": 40, "name": "Guest"}],
        )
        self.assertEqual(ports[last.pk]["vlanMode"], InterfaceModeChoices.MODE_ACCESS)
        self.assertIsNone(ports[last.pk]["untaggedVlan"])
        self.assertEqual(ports[last.pk]["poeMode"], "")
        self.assertEqual(ports[last.pk]["poeType"], "")

        CableEditorSettings.objects.update_or_create(pk=1, defaults={"options": {"features": {"vlan": False}}})
        ports = get_ports()
        self.assertEqual(ports[first.pk]["vlanMode"], "")
        self.assertIsNone(ports[first.pk]["untaggedVlan"])
        self.assertEqual(ports[first.pk]["taggedVlans"], [])
        self.assertTrue(ports[first.pk]["managementOnly"])

    def test_vlan_editor_color_is_an_optional_validated_vlan_field(self):
        field = CustomField.objects.get(name="editorColorHex", object_types__app_label="ipam", object_types__model="vlan")
        self.assertEqual(field.type, "text")
        self.assertFalse(field.required)
        for color in (None, "#16a34a", "#FF0000"):
            field.validate(color)
        for invalid in ("red", "16a34a", "#fff", "#16A34A\n"):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                field.validate(invalid)

    def test_hidden_vlan_editor_color_is_not_returned(self):
        self.add_permissions("ipam.view_vlan")
        vlan = VLAN.objects.create(vid=10, name="Management", custom_field_data={"editorColorHex": "#16A34A"})
        interface = Interface.objects.get(device=self.device, name=self.first.name)
        Interface.objects.filter(pk=interface.pk).update(untagged_vlan=vlan)
        url = self.route("rack", self.rack)

        def get_vlan():
            data = self.client.get(url).context["rack_data"]
            return next(port["untaggedVlan"] for device in data["devices"] for port in device["ports"]
                        if port["id"] == interface.pk)

        self.assertEqual(get_vlan(), {"vid": 10, "name": "Management", "color": "#16A34A"})
        CustomField.objects.filter(name="editorColorHex").update(ui_visible=CustomFieldUIVisibleChoices.HIDDEN)
        self.assertEqual(get_vlan(), {"vid": 10, "name": "Management"})

    def test_external_destinations_use_readable_placement_and_respect_the_feature_toggle(self):
        self.add_permissions("dcim.view_location", "dcim.view_site")
        site = self.other_rack.site
        location = Location.objects.create(site=site, name="Remote office", slug="remote-office")
        self.other_rack.location = location
        self.other_rack.save()
        local = Interface.objects.get(device=self.device, name=self.first.name)
        remote = Interface.objects.get(device=self.external, name=self.first.name)
        cable = Cable.objects.create(a_terminations=[local], b_terminations=[remote])

        def read_cable():
            data = self.client.get(self.route("rack", self.rack)).context["rack_data"]
            return next(row for row in data["cables"] if row["id"] == cable.pk)

        expected = {
            "location": {"id": location.pk, "name": location.name},
            "site": {"id": site.pk, "name": site.name},
            "rack": {"id": self.other_rack.pk, "name": self.other_rack.name},
            "device": {"id": self.external.pk, "name": self.external.name},
            "port": {"id": remote.pk, "name": remote.name},
        }
        self.assertEqual(read_cable()["externalDestinations"], [expected])
        trace = {
            "departurePort": local.pk,
            "destination": {
                **expected, "otherRack": True, "otherLocation": True, "otherSite": False, "unracked": False,
            },
        }
        self.assertEqual(read_cable()["externalTraces"], [trace])
        settings, _ = CableEditorSettings.objects.update_or_create(
            pk=1, defaults={"options": {"features": {"externalLocations": False, "connectionFilter": False}}},
        )
        self.assertNotIn("externalDestinations", read_cable())
        self.assertEqual(read_cable()["externalTraces"], [trace])
        settings.options = {"features": dict.fromkeys(TRACE_DESTINATION_FEATURES, False)}
        settings.save(update_fields=("options",))
        self.assertNotIn("externalTraces", read_cable())
        self.assertEqual(read_cable()["externalDestinations"], [expected])
        settings.options = {"features": {"connectionFilter": False}}
        settings.save(update_fields=("options",))
        self.assertEqual(read_cable()["externalDestinations"], [expected])

        self.remove_permissions("dcim.view_location", "dcim.view_site")
        self.restrict_view(Rack, {"pk": self.rack.pk})
        self.assertEqual(read_cable()["externalDestinations"], [{**expected, "location": None, "site": None, "rack": None}])
        self.assertNotIn("externalTraces", read_cable())
        self.restrict_view(Interface, {"device_id": self.device.pk})
        self.assertNotIn("externalDestinations", read_cable())

    def test_remote_endpoint_metadata_respects_interface_rack_and_type_visibility(self):
        native = VLAN.objects.create(vid=15, name="Remote native")
        tagged = VLAN.objects.create(vid=25, name="Remote tagged")
        self.add_permissions(
            "ipam.view_vlan", "dcim.view_devicerole", "dcim.view_site", "dcim.view_manufacturer", "extras.view_tag",
        )
        device_tag = Tag.objects.create(name="Service device", slug="service-device")
        type_tag = Tag.objects.create(name="Panel type", slug="panel-type")
        self.external.tags.add(device_tag)
        self.device_type.tags.add(type_tag)
        local = Interface.objects.get(device=self.device, name=self.first.name)
        remote = Interface.objects.get(device=self.external, name=self.first.name)
        remote.label = "Office uplink"
        remote.description = "Patch lead to the remote rack."
        remote.enabled = False
        remote.poe_mode = InterfacePoEModeChoices.MODE_PSE
        remote.poe_type = InterfacePoETypeChoices.TYPE_2_8023AT
        remote.mode = InterfaceModeChoices.MODE_TAGGED
        remote.untagged_vlan = native
        remote.save()
        remote.tagged_vlans.add(tagged)
        cable = Cable.objects.create(a_terminations=[remote], b_terminations=[local])

        def get_cable():
            response = self.client.get(self.route("rack", self.rack))
            return next(row for row in response.context["rack_data"]["cables"] if row["id"] == cable.pk)

        endpoint = get_cable()["endpointA"]
        self.assertEqual(endpoint, {
            "kind": "interface",
            "label": remote.label,
            "description": remote.description,
            "enabled": False,
            "type": remote.get_type_display(),
            "poeMode": remote.get_poe_mode_display(),
            "poeType": remote.get_poe_type_display(),
            "deviceName": self.external.name,
            "deviceUrl": self.external.get_absolute_url(),
            "filterDeviceId": self.external.pk,
            "portName": remote.name,
            "portUrl": remote.get_absolute_url(),
            "deviceType": self.device_type.model,
            "deviceTypeId": self.device_type.pk,
            "rackName": self.other_rack.name,
            "vlanMode": InterfaceModeChoices.MODE_TAGGED,
            "vlanModeDisplay": remote.get_mode_display(),
            "untaggedVlan": {"vid": 15, "name": "Remote native"},
            "taggedVlans": [{"vid": 25, "name": "Remote tagged"}],
            "filter": {"interfaceId": remote.pk},
            "deviceFilter": {
                "deviceRoles": [{"id": self.external.role_id, "name": self.external.role.name}],
                "deviceTags": [{"id": device_tag.pk, "name": device_tag.name}],
                "deviceTypeTags": [{"id": type_tag.pk, "name": type_tag.name}],
                "deviceManufacturers": [{"id": self.device_type.manufacturer_id,
                                         "name": self.device_type.manufacturer.name}],
                "rack": {"id": self.other_rack.pk, "name": self.other_rack.name},
                "site": {"id": self.external.site_id, "name": self.external.site.name},
                "outsideRack": True,
            },
        })

        self.restrict_view(Rack, {"pk": self.rack.pk})
        self.restrict_view(Tag, {"pk": type_tag.pk})
        self.remove_permissions("dcim.view_devicetype", "ipam.view_vlan", "dcim.view_site")
        restricted = get_cable()
        self.assertIsNone(restricted["a"])
        self.assertEqual(restricted["b"], local.pk)
        self.assertFalse(restricted["editable"])
        self.assertFalse(restricted["deletable"])
        expected = {**endpoint, "untaggedVlan": None, "taggedVlans": [], "deviceFilter": {
            **endpoint["deviceFilter"], "rack": None, "site": None, "deviceTags": [], "deviceTypeTags": [],
            "deviceManufacturers": [],
        }}
        del expected["deviceType"], expected["deviceTypeId"], expected["rackName"]
        self.assertEqual(restricted["endpointA"], expected)

        self.restrict_view(Interface, {"device_id": self.device.pk})
        self.assertIsNone(get_cable()["endpointA"])

    def test_destination_search_includes_unconnected_readable_racks_locations_and_sites(self):
        self.add_permissions("dcim.view_site", "dcim.view_location")
        remote_site = Site.objects.create(name="Destination facility", slug="destination-facility")
        remote_location = Location.objects.create(site=remote_site, name="Destination room", slug="destination-room")
        remote_rack = Rack.objects.create(site=remote_site, location=remote_location, name="Destination cabinet")
        response = self.client.get(self.route("rack", self.rack))
        urls = response.context["rack_data"]["filterDestinationUrls"]
        for scope, obj in (("racks", remote_rack), ("locations", remote_location), ("sites", remote_site)):
            results = self.client.get(urls[scope], {"q": "Destination", "fields": "id,name", "limit": 40}).json()
            self.assertEqual(results["results"], [{"id": obj.pk, "name": obj.name}])

        self.restrict_view(Rack, {"pk": self.rack.pk})
        results = self.client.get(urls["racks"], {"q": "Destination", "fields": "id,name", "limit": 40}).json()
        self.assertEqual(results["results"], [])

    def test_trace_uses_unmapped_passive_ports_as_direct_ends(self):
        local = FrontPort.objects.create(device=self.peer, name="Local socket", type=PortTypeChoices.TYPE_8P8C)
        remote = FrontPort.objects.create(device=self.external, name="Remote socket", type=PortTypeChoices.TYPE_8P8C)
        cable = Cable.objects.create(a_terminations=[local], b_terminations=[remote])

        def trace():
            response = self.client.get(self.route("rack", self.rack))
            return next(row["filterTrace"] for row in response.context["rack_data"]["cables"] if row["id"] == cable.pk)

        local_ref, remote_ref = f"front-port:{local.pk}", f"front-port:{remote.pk}"
        self.assertCountEqual(trace()["ends"], [local_ref, remote_ref])
        rear = RearPort.objects.create(device=self.external, name="Mapped rear", type=PortTypeChoices.TYPE_8P8C)
        PortMapping.objects.create(
            device=self.external, front_port=remote, front_port_position=1, rear_port=rear, rear_port_position=1,
        )
        mapped = trace()
        self.assertEqual(mapped["ends"], [local_ref])
        self.assertCountEqual(mapped["along"], [local_ref, remote_ref])

    def test_native_trace_through_panel_and_outlet_is_open_or_complete_and_respects_permissions(self):
        self.add_permissions(
            "dcim.change_cable", "dcim.delete_cable", "dcim.view_frontporttemplate", "dcim.view_rearporttemplate",
            "dcim.view_location", "dcim.view_site",
        )
        local_room = Location.objects.create(site=self.rack.site, name="Rack room", slug="rack-room")
        remote_room = Location.objects.create(site=self.rack.site, name="Office", slug="office")
        Rack.objects.filter(pk=self.rack.pk).update(location=local_room)
        Rack.objects.filter(pk=self.other_rack.pk).update(location=remote_room)
        switch_port = Interface.objects.get(device=self.device, name=self.first.name)
        client = Device.objects.create(
            device_type=self.device_type, role=self.device.role, site=self.device.site, rack=self.other_rack,
            name="Office client", position=5, face="front",
        )
        client_port = Interface.objects.get(device=client, name=self.first.name)

        def mapped_ports(device, name):
            front = FrontPort.objects.create(device=device, name=f"{name} front", type=PortTypeChoices.TYPE_8P8C)
            rear = RearPort.objects.create(device=device, name=f"{name} rear", type=PortTypeChoices.TYPE_8P8C)
            PortMapping.objects.create(
                device=device, front_port=front, front_port_position=1, rear_port=rear, rear_port_position=1,
            )
            return front, rear

        panel_front, panel_rear = mapped_ports(self.peer, "Panel")
        outlet_front, outlet_rear = mapped_ports(self.external, "Outlet")
        front_template = FrontPortTemplate.objects.create(
            device_type=self.peer.device_type, name=panel_front.name, type=PortTypeChoices.TYPE_8P8C,
        )
        rear_template = RearPortTemplate.objects.create(
            device_type=self.peer.device_type, name=panel_rear.name, type=PortTypeChoices.TYPE_8P8C,
        )
        PortPlacement.objects.create(front_port_template=front_template, face="front", x=0.3, y=0.4)
        PortPlacement.objects.create(rear_port_template=rear_template, face="rear", x=0.6, y=0.4)
        lead = Cable.objects.create(a_terminations=[switch_port], b_terminations=[panel_front])
        backbone = Cable.objects.create(a_terminations=[panel_rear], b_terminations=[outlet_rear], color="cc8833",
                                        label="Backbone to wall outlet")
        front_id = f"front-port:{panel_front.pk}"
        rear_id = f"rear-port:{panel_rear.pk}"

        def read_lead():
            response = self.client.get(self.route("rack", self.rack))
            return next(row for row in response.context["rack_data"]["cables"] if row["id"] == lead.pk)

        lead_row = read_lead()
        self.assertEqual(lead_row["a"], switch_port.pk)
        self.assertEqual(lead_row["b"], front_id)
        self.assertTrue(lead_row["editable"])
        self.assertTrue(lead_row["deletable"])
        self.assertIsNone(lead_row["endpointB"])
        data = self.client.get(self.route("rack", self.rack)).context["rack_data"]
        peer_ports = {port["id"]: port for device in data["devices"] if device["id"] == self.peer.pk
                      for port in device["ports"]}
        self.assertEqual(
            [(peer_ports[key]["kind"], peer_ports[key]["face"], peer_ports[key]["x"]) for key in (front_id, rear_id)],
            [("front-port", "front", 0.3), ("rear-port", "rear", 0.6)],
        )
        backbone_row = next(row for row in data["cables"] if row["id"] == backbone.pk)
        self.assertEqual(backbone_row["a"], rear_id)
        self.assertIsNone(backbone_row["b"])
        self.assertNotIn("externalDestinations", lead_row)
        self.assertNotIn("externalTraces", lead_row)
        self.assertEqual([row["device"]["id"] for row in backbone_row["externalDestinations"]], [self.external.pk])
        open_route, = backbone_row["externalTraces"]
        self.assertEqual(
            (open_route["departurePort"], open_route["incomingPort"], open_route["incomingCableId"]),
            (rear_id, front_id, lead.pk),
        )
        self.assertEqual(open_route["destination"]["port"]["id"], f"front-port:{outlet_front.pk}")
        self.assertEqual(backbone_row["endpointB"]["portName"], outlet_rear.name)
        self.assertEqual(backbone_row["endpointB"]["portUrl"], outlet_rear.get_absolute_url())
        self.assertEqual(backbone_row["endpointB"]["deviceUrl"], self.external.get_absolute_url())
        self.assertEqual(backbone_row["endpointB"]["type"], outlet_rear.get_type_display())
        self.assertNotIn("vlanMode", backbone_row["endpointB"])
        self.assertFalse(backbone_row["editable"])
        self.assertFalse(backbone_row["deletable"])
        self.assertIsNone(lead_row["traceA"])
        trace = lead_row["traceB"]
        self.assertEqual(trace["status"], "open")
        self.assertEqual(trace["hops"][0]["portId"], switch_port.pk)
        self.assertEqual(
            [hop["portName"] for hop in trace["hops"]],
            [switch_port.name, panel_front.name, panel_rear.name, outlet_rear.name, outlet_front.name],
        )
        self.assertEqual([hop.get("portId") for hop in trace["hops"]], [switch_port.pk, front_id, rear_id, None, None])
        segment, = trace["segments"]
        self.assertEqual((segment["id"], segment["a"], segment["b"], segment["color"], segment["label"]),
                         (backbone.pk, rear_id, None, "cc8833", "Backbone to wall outlet"))
        self.assertEqual(segment["endpointA"]["portName"], panel_rear.name)
        self.assertEqual(segment["endpointB"]["portName"], outlet_rear.name)

        def matched_devices(rack, entry, scope):
            catalog = rack["filterTraceEndpoints"]
            return {catalog[key]["device"]["id"] for key in entry["filterTrace"][scope]}

        self.assertEqual(matched_devices(data, peer_ports[front_id], "next"), {self.device.pk, self.external.pk})
        self.assertEqual(matched_devices(data, peer_ports[rear_id], "next"), {self.device.pk, self.external.pk})
        self.assertEqual(matched_devices(data, backbone_row, "next"), {self.device.pk, self.peer.pk, self.external.pk})
        self.assertEqual(matched_devices(data, backbone_row, "any"), {self.device.pk, self.peer.pk, self.external.pk})
        self.assertIn(self.external.pk, matched_devices(data, lead_row, "any"))
        switch_row = next(port for device in data["devices"] for port in device["ports"] if port["id"] == switch_port.pk)
        self.assertEqual(matched_devices(data, switch_row, "next"), {self.peer.pk})
        self.assertEqual(matched_devices(data, switch_row, "any"), {self.peer.pk, self.external.pk})
        self.assertEqual(matched_devices(data, lead_row, "along"), {self.device.pk, self.peer.pk, self.external.pk})
        self.assertEqual(matched_devices(data, lead_row, "ends"), {self.device.pk, self.external.pk})
        self.assertEqual(matched_devices(data, switch_row, "ends"), {self.external.pk})
        self.assertEqual(data["locationId"], local_room.pk)
        self.assertEqual(data["filterTraceEndpoints"][f"front-port:{outlet_front.pk}"]["device"]["filter"]["tracePlace"],
                         {"rackId": self.other_rack.pk, "rackLocationId": remote_room.pk,
                          "locationId": remote_room.pk, "siteId": self.rack.site_id})
        self.assertEqual(data["filterTraceEndpoints"][f"rear-port:{outlet_rear.pk}"]["device"]["deviceTypeId"],
                         self.external.device_type_id)

        client_vlan = VLAN.objects.create(vid=20, name="Client network")
        client_port.mode = InterfaceModeChoices.MODE_ACCESS
        client_port.untagged_vlan = client_vlan
        client_port.save()
        self.add_permissions("ipam.view_vlan")
        drop = Cable.objects.create(a_terminations=[outlet_front], b_terminations=[client_port])
        trace = read_lead()["traceB"]
        self.assertEqual(trace["status"], "complete")
        self.assertTrue(trace["active"])
        self.assertEqual(trace["hops"][-1]["deviceName"], client.name)
        self.assertEqual(trace["hops"][-1]["portName"], client_port.name)
        self.assertEqual(trace["hops"][-1]["deviceUrl"], client.get_absolute_url())
        self.assertEqual(trace["hops"][-1]["portUrl"], client_port.get_absolute_url())
        self.assertEqual(trace["hops"][-1]["type"], client_port.get_type_display())
        self.assertEqual(trace["hops"][-1]["vlanModeDisplay"], client_port.get_mode_display())
        self.assertEqual(trace["hops"][-1]["untaggedVlan"], {"vid": 20, "name": "Client network"})
        self.assertNotIn("portId", trace["hops"][-1])
        self.assertEqual([segment["id"] for segment in trace["segments"]], [backbone.pk, drop.pk])
        data = self.client.get(self.route("rack", self.rack)).context["rack_data"]
        lead_row = next(row for row in data["cables"] if row["id"] == lead.pk)
        backbone_row = next(row for row in data["cables"] if row["id"] == backbone.pk)
        self.assertEqual(matched_devices(data, lead_row, "ends"), {self.device.pk, client.pk})
        self.assertIn(self.external.pk, matched_devices(data, lead_row, "along"))
        self.assertEqual([row["device"]["id"] for row in backbone_row["externalDestinations"]],
                         [self.external.pk, client.pk])
        self.assertEqual(backbone_row["externalDestinations"][1]["port"], {"id": client_port.pk, "name": client_port.name})
        complete_route, = backbone_row["externalTraces"]
        self.assertEqual(complete_route["destination"]["device"]["id"], client.pk)
        self.assertEqual(complete_route["destination"]["port"]["id"], client_port.pk)

        remote_site = Site.objects.create(name="Remote trace site", slug="remote-trace-site")
        remote_office = Location.objects.create(site=remote_site, name="Remote trace office", slug="remote-trace-office")
        Device.objects.filter(pk=client.pk).update(rack=None, position=None, site=remote_site, location=remote_office)
        data = self.client.get(self.route("rack", self.rack)).context["rack_data"]
        backbone_row = next(row for row in data["cables"] if row["id"] == backbone.pk)
        unracked, = backbone_row["externalTraces"]
        self.assertIsNone(unracked["destination"]["rack"])
        self.assertFalse(unracked["destination"]["otherRack"])
        self.assertTrue(unracked["destination"]["unracked"])
        self.assertTrue(unracked["destination"]["otherSite"])
        self.assertTrue(unracked["destination"]["otherLocation"])

        self.restrict_view(Interface, {"device_id": self.device.pk})
        data = self.client.get(self.route("rack", self.rack)).context["rack_data"]
        backbone_row = next(row for row in data["cables"] if row["id"] == backbone.pk)
        self.assertEqual([row["device"]["id"] for row in backbone_row["externalDestinations"]], [self.external.pk])
        self.assertNotIn("externalTraces", backbone_row)

        self.restrict_view(Cable, {"pk": lead.pk})
        trace = read_lead()["traceB"]
        self.assertEqual(trace["status"], "restricted")
        self.assertNotIn("active", trace)
        self.assertEqual([hop["portName"] for hop in trace["hops"]], [switch_port.name, panel_front.name, panel_rear.name])
        self.assertNotIn(client_port.get_absolute_url(), [hop["portUrl"] for hop in trace["hops"]])
        self.assertEqual(trace["segments"], [])
        restricted = self.client.get(self.route("rack", self.rack)).context["rack_data"]
        restricted_lead = next(row for row in restricted["cables"] if row["id"] == lead.pk)
        self.assertEqual(matched_devices(restricted, restricted_lead, "any"), {self.device.pk, self.peer.pk})
        self.assertEqual(matched_devices(restricted, restricted_lead, "along"), {self.device.pk, self.peer.pk})
        self.assertEqual(matched_devices(restricted, restricted_lead, "ends"), {self.device.pk})
        self.assertNotIn(f"rear-port:{outlet_rear.pk}", restricted["filterTraceEndpoints"])
        self.assertNotIn(client_port.pk, restricted["filterTraceEndpoints"])

        self.remove_permissions("dcim.view_rearport")
        trace = read_lead()["traceB"]
        self.assertEqual(trace["status"], "restricted")
        self.assertEqual([hop["portName"] for hop in trace["hops"]], [switch_port.name, panel_front.name])
        self.assertEqual(trace["segments"], [])

        self.remove_permissions("dcim.view_frontport")
        restricted = read_lead()
        self.assertIsNone(restricted["b"])
        self.assertIsNone(restricted["endpointB"])
        self.assertFalse(restricted["editable"])
        self.assertEqual(restricted["traceB"]["status"], "restricted")
        self.assertEqual([hop["portName"] for hop in restricted["traceB"]["hops"]], [switch_port.name])

    def test_ports_distinguish_admin_state_from_occupancy(self):
        disabled = Interface.objects.create(
            device=self.device, name="Disabled", type=InterfaceTypeChoices.TYPE_1GE_FIXED, enabled=False,
        )
        marked = Interface.objects.create(
            device=self.device, name="Marked", type=InterfaceTypeChoices.TYPE_1GE_FIXED, mark_connected=True,
        )
        virtual = Interface.objects.create(
            device=self.device, name="Virtual", type=InterfaceTypeChoices.TYPE_VIRTUAL,
        )
        data = self.client.get(self.route("rack", self.rack)).context["rack_data"]
        ports = {port["id"]: port for device in data["devices"] for port in device["ports"]}
        for interface, state in (
            (disabled, (False, "free", False)), (marked, (True, "marked", True)), (virtual, (True, "free", True)),
        ):
            with self.subTest(interface=interface):
                port = ports[interface.pk]
                self.assertEqual((port["enabled"], port["occupancy"], port["blocked"]), state)
