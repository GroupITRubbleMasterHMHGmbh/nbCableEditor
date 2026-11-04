from django.test import Client
from django.urls import reverse

from core.models import ObjectChange, ObjectType
from dcim.choices import InterfaceTypeChoices, PortTypeChoices
from dcim.models import Device, DeviceRole, DeviceType, FrontPort, Interface, Manufacturer, Rack, RearPort, Site
from extras.models import Tag
from users.models import ObjectPermission
from utilities.testing import TestCase

from netbox_rack_editor.cable_views import port_key


class PortMetadataTestCase(TestCase):
    user_permissions = (
        "dcim.view_rack", "dcim.view_device", "dcim.view_interface", "dcim.change_interface", "extras.view_tag",
    )

    @classmethod
    def setUpTestData(cls):
        site = Site.objects.create(name="Metadata Site", slug="metadata-site")
        manufacturer = Manufacturer.objects.create(name="Test Manufacturer", slug="test-manufacturer")
        device_type = DeviceType.objects.create(manufacturer=manufacturer, model="Test Switch", slug="test-switch")
        role = DeviceRole.objects.create(name="Test Role", slug="test-role")
        cls.rack = Rack.objects.create(site=site, name="Primary Rack")
        external_rack = Rack.objects.create(site=site, name="Secondary Rack")
        cls.device = Device.objects.create(site=site, rack=cls.rack, role=role, device_type=device_type, name="Local")
        external_device = Device.objects.create(
            site=site, rack=external_rack, role=role, device_type=device_type, name="External",
        )
        cls.port = Interface.objects.create(
            device=cls.device, name="eth1", type=InterfaceTypeChoices.TYPE_1GE_FIXED, label="Original",
        )
        cls.external = Interface.objects.create(
            device=external_device, name="eth1", type=InterfaceTypeChoices.TYPE_1GE_FIXED,
        )
        cls.front = FrontPort.objects.create(device=cls.device, name="Panel front", type=PortTypeChoices.TYPE_8P8C)
        cls.rear = RearPort.objects.create(device=cls.device, name="Panel rear", type=PortTypeChoices.TYPE_8P8C)
        cls.initial_tag = Tag.objects.create(name="Initial", slug="initial", color="ffaabb")
        cls.hidden_tag = Tag.objects.create(name="Hidden", slug="hidden", color="000000")
        cls.interface_tag = Tag.objects.create(name="Interface tag", slug="interface-tag", color="0033ff")
        cls.interface_tag.object_types.add(ObjectType.objects.get_for_model(Interface))
        cls.panel_tag = Tag.objects.create(name="Panel tag", slug="panel-tag", color="00ffaa")
        cls.panel_tag.object_types.add(ObjectType.objects.get_for_model(FrontPort))
        cls.port.tags.add(cls.initial_tag, cls.hidden_tag)

    @property
    def url(self):
        return reverse("plugins:netbox_rack_editor:ports", args=[self.rack.pk])

    def update(self, port=None, **data):
        port = self.port if port is None else port
        return self.client.post(self.url, {"port_id": port_key(type(port), port.pk), **data}, content_type="application/json")

    def restrict_permission(self, model, action, constraints):
        self.remove_permissions(f"{model._meta.app_label}.{action}_{model._meta.model_name}")
        permission = ObjectPermission.objects.create(
            name=f"Restricted {model._meta.model_name} {action}", actions=[action], constraints=constraints,
        )
        permission.object_types.add(ObjectType.objects.get_for_model(model))
        permission.users.add(self.user)

    def test_partial_port_metadata_update_preserves_hidden_tags_and_logs_label(self):
        self.restrict_permission(Tag, "view", {"pk__in": [self.initial_tag.pk, self.interface_tag.pk]})
        result = self.update(label="Patch 01", expected_label="Original")
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual(result.json(), {
            "id": self.port.pk, "label": "Patch 01",
            "tags": [{"id": self.initial_tag.pk, "name": self.initial_tag.name, "color": self.initial_tag.color}],
        })
        change = ObjectChange.objects.get(request_id=result["X-Request-ID"], changed_object_id=self.port.pk)
        self.assertEqual(change.prechange_data["label"], "Original")
        self.assertEqual(change.postchange_data["label"], "Patch 01")

        result = self.update(tags=[self.interface_tag.pk], expected_tags=[self.initial_tag.pk])
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual(result.json()["label"], "Patch 01")
        self.assertEqual(result.json()["tags"], [{
            "id": self.interface_tag.pk, "name": self.interface_tag.name, "color": self.interface_tag.color,
        }])
        self.assertCountEqual(self.port.tags.values_list("pk", flat=True), (self.interface_tag.pk, self.hidden_tag.pk))

        self.assertEqual(self.update(tags=[], expected_tags=[self.initial_tag.pk]).status_code, 409)
        self.assertEqual(self.update(tags=[self.hidden_tag.pk]).status_code, 400)
        self.assertEqual(self.update(label="Stale", expected_label="Original").status_code, 409)
        self.port.refresh_from_db()
        self.assertEqual(self.port.label, "Patch 01")
        self.assertCountEqual(self.port.tags.values_list("pk", flat=True), (self.interface_tag.pk, self.hidden_tag.pk))

    def test_model_scoped_tags_and_typed_passive_port_ids(self):
        self.add_permissions("dcim.view_frontport", "dcim.change_frontport", "dcim.view_rearport", "dcim.change_rearport")
        invalid = self.update(label="Must roll back", tags=[self.panel_tag.pk])
        self.assertEqual(invalid.status_code, 400, invalid.content)
        self.port.refresh_from_db()
        self.assertEqual(self.port.label, "Original")

        result = self.update(self.front, label="Front 01", tags=[self.panel_tag.pk])
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual(result.json()["id"], port_key(FrontPort, self.front.pk))
        self.assertEqual(result.json()["tags"][0]["id"], self.panel_tag.pk)

        result = self.update(self.rear, label="Rear 01", tags=[self.initial_tag.pk])
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual(result.json()["id"], port_key(RearPort, self.rear.pk))
        self.assertEqual(self.update(self.rear, tags=[self.panel_tag.pk]).status_code, 400)

    def test_rack_scope_object_permissions_and_csrf(self):
        self.assertEqual(self.update(self.external, label="Outside").status_code, 404)
        self.restrict_permission(Interface, "change", {"label": "Original"})
        denied = self.update(label="Leaves permission scope")
        self.assertEqual(denied.status_code, 403, denied.content)
        self.port.refresh_from_db()
        self.assertEqual(self.port.label, "Original")
        self.assertEqual(self.update(label="X" * 65).status_code, 400)

        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        result = csrf_client.post(self.url, {"port_id": self.port.pk, "label": "X"}, content_type="application/json")
        self.assertEqual(result.status_code, 403)

        self.remove_permissions("dcim.view_device")
        self.assertEqual(self.update(label="Hidden").status_code, 404)
