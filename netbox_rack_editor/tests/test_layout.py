from core.models import ObjectType
from dcim.choices import (
    CableTypeChoices, InterfaceDuplexChoices, InterfaceModeChoices, InterfacePoEModeChoices, InterfacePoETypeChoices,
    InterfaceTypeChoices, PortTypeChoices,
)
from dcim.models import (
    Cable, Device, DeviceRole, DeviceType, FrontPort, FrontPortTemplate, Interface, InterfaceTemplate, Manufacturer,
    PortMapping, Rack, RearPort, RearPortTemplate, Site,
)
from django.core.exceptions import ValidationError
from django.urls import reverse
from extras.models import CustomField, JournalEntry
from ipam.models import VLAN
from users.models import ObjectPermission
from utilities.testing import TestCase

from netbox_rack_editor.models import PortPlacement


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
        return reverse(f"plugins:netbox_rack_editor:{name}", args=[(obj or self.device_type).pk])

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
            self.assertEqual((ports["Ethernet2"]["face"], ports["Ethernet2"]["x"]), ("front", 0.2))
            self.assertEqual((ports["Ethernet10"]["face"], ports["Ethernet10"]["x"]), ("rear", 0.9))
            self.assertTrue(device["rearImage"].endswith("/rear.png"))
        self.assertEqual(self.save(1).json(), {"revision": 2})
        self.assertFalse(PortPlacement.objects.exists())

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

    def test_vlan_editor_color_is_an_optional_validated_vlan_field(self):
        field = CustomField.objects.get(name="editorColorHex", object_types__app_label="ipam", object_types__model="vlan")
        self.assertEqual(field.type, "text")
        self.assertFalse(field.required)
        for color in (None, "#16a34a", "#FF0000"):
            field.validate(color)
        for invalid in ("red", "16a34a", "#fff", "#16A34A\n"):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                field.validate(invalid)

    def test_remote_endpoint_metadata_respects_interface_rack_and_type_visibility(self):
        native = VLAN.objects.create(vid=15, name="Remote native")
        tagged = VLAN.objects.create(vid=25, name="Remote tagged")
        self.add_permissions("ipam.view_vlan")
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
            "portName": remote.name,
            "portUrl": remote.get_absolute_url(),
            "deviceType": self.device_type.model,
            "rackName": self.other_rack.name,
            "vlanMode": InterfaceModeChoices.MODE_TAGGED,
            "vlanModeDisplay": remote.get_mode_display(),
            "untaggedVlan": {"vid": 15, "name": "Remote native"},
            "taggedVlans": [{"vid": 25, "name": "Remote tagged"}],
        })

        self.restrict_view(Rack, {"pk": self.rack.pk})
        self.remove_permissions("dcim.view_devicetype", "ipam.view_vlan")
        restricted = get_cable()
        self.assertIsNone(restricted["a"])
        self.assertEqual(restricted["b"], local.pk)
        self.assertFalse(restricted["editable"])
        self.assertFalse(restricted["deletable"])
        expected = {**endpoint, "untaggedVlan": None, "taggedVlans": []}
        del expected["deviceType"], expected["rackName"]
        self.assertEqual(restricted["endpointA"], expected)

        self.restrict_view(Interface, {"device_id": self.device.pk})
        self.assertIsNone(get_cable()["endpointA"])

    def test_native_trace_through_panel_and_outlet_is_open_or_complete_and_respects_permissions(self):
        self.add_permissions("dcim.change_cable", "dcim.delete_cable")
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
        backbone = Cable.objects.create(a_terminations=[panel_rear], b_terminations=[outlet_rear], color="cc8833")
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
        self.assertEqual(trace["segments"], [{"id": backbone.pk, "a": rear_id, "b": None, "color": "cc8833"}])

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

        self.restrict_view(Cable, {"pk": lead.pk})
        trace = read_lead()["traceB"]
        self.assertEqual(trace["status"], "restricted")
        self.assertNotIn("active", trace)
        self.assertEqual([hop["portName"] for hop in trace["hops"]], [switch_port.name, panel_front.name, panel_rear.name])
        self.assertNotIn(client_port.get_absolute_url(), [hop["portUrl"] for hop in trace["hops"]])
        self.assertEqual(trace["segments"], [])

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
