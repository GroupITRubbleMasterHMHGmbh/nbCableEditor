from dcim.choices import InterfaceTypeChoices, PortTypeChoices
from dcim.models import DeviceType, FrontPortTemplate, InterfaceTemplate, Manufacturer, RearPortTemplate
from django.urls import reverse
from utilities.testing import TestCase

from netbox_rack_editor.models import PortPlacement


class PassivePortLayoutTestCase(TestCase):
    user_permissions = (
        "dcim.view_devicetype", "dcim.change_devicetype", "dcim.view_interfacetemplate",
        "dcim.view_frontporttemplate", "dcim.view_rearporttemplate",
    )

    @classmethod
    def setUpTestData(cls):
        manufacturer = Manufacturer.objects.create(name="Passive Layout", slug="passive-layout")
        cls.device_type = DeviceType.objects.create(manufacturer=manufacturer, model="Panel", slug="panel")
        other = DeviceType.objects.create(manufacturer=manufacturer, model="Other Panel", slug="other-panel")
        cls.interface = InterfaceTemplate.objects.create(
            device_type=cls.device_type, name="Ethernet1", type=InterfaceTypeChoices.TYPE_1GE_FIXED,
        )
        # The three native template tables can legitimately contain the same primary key.
        cls.front = FrontPortTemplate.objects.create(
            pk=cls.interface.pk, device_type=cls.device_type, name="P01", type=PortTypeChoices.TYPE_8P8C,
        )
        cls.rear = RearPortTemplate.objects.create(
            pk=cls.interface.pk, device_type=cls.device_type, name="P01", type=PortTypeChoices.TYPE_8P8C,
        )
        cls.foreign = FrontPortTemplate.objects.create(
            pk=cls.interface.pk + 1000000, device_type=other, name="P01", type=PortTypeChoices.TYPE_8P8C,
        )
        cls.front_key = f"front-port:{cls.front.pk}"
        cls.rear_key = f"rear-port:{cls.rear.pk}"

    def route(self, name):
        return reverse(f"plugins:netbox_rack_editor:{name}", args=[self.device_type.pk])

    def read(self):
        return self.client.get(self.route("layout")).context["layout_data"]

    def save(self, revision, *placements):
        return self.client.post(
            self.route("placements"), {"revision": revision, "placements": placements}, content_type="application/json",
        )

    def point(self, key, face, x=.2):
        return {"port_id": key, "face": face, "x": x, "y": .7}

    def test_legacy_interface_and_typed_passive_placements_round_trip(self):
        expected = {
            self.interface.pk: (None, "interface"), self.front_key: ("front", "front-port"),
            self.rear_key: ("rear", "rear-port"),
        }
        self.assertEqual({row["id"]: (row["fixedFace"], row["kind"]) for row in self.read()["ports"]}, expected)

        old = self.point(self.interface.pk, "rear")
        PortPlacement.objects.create(interface_template=self.interface, face="rear", x=old["x"], y=old["y"])
        self.assertEqual(self.read()["placements"], [old])

        front, rear = self.point(self.front_key, "front"), self.point(self.rear_key, "rear")
        saved = self.save(0, old, front, rear)
        self.assertEqual(saved.status_code, 200, saved.content)
        self.assertEqual(saved.json(), {"revision": 1})
        self.assertCountEqual(self.read()["placements"], [old, front, rear])
        self.assertTrue(PortPlacement.objects.filter(front_port_template=self.front, face="front").exists())
        self.assertTrue(PortPlacement.objects.filter(rear_port_template=self.rear, face="rear").exists())

    def test_wrong_face_duplicate_and_foreign_template_rejected_without_replacing_layout(self):
        front = self.point(self.front_key, "front")
        self.assertEqual(self.save(0, front).status_code, 200)
        for points in (
            [self.point(self.front_key, "rear")],
            [self.point(self.rear_key, "front")],
            [front, front],
            [self.point(f"front-port:{self.foreign.pk}", "front")],
            [self.point("front-port:9223372036854775808", "front")],
        ):
            with self.subTest(points=points):
                self.assertEqual(self.save(1, *points).status_code, 400)
                self.assertEqual(self.read()["placements"], [front])

    def test_save_preserves_passive_positions_hidden_by_template_permissions(self):
        front, rear = self.point(self.front_key, "front"), self.point(self.rear_key, "rear")
        self.assertEqual(self.save(0, front, rear).status_code, 200)
        self.remove_permissions("dcim.view_rearporttemplate")
        self.assertNotIn(self.rear_key, {row["id"] for row in self.read()["ports"]})
        self.assertEqual(self.read()["placements"], [front])
        self.assertEqual(self.save(1, rear).status_code, 400)
        self.assertEqual(self.save(1).status_code, 200)
        self.assertEqual(PortPlacement.objects.get().rear_port_template_id, self.rear.pk)
