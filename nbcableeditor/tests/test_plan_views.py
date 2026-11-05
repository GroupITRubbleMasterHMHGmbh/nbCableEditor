from django.urls import reverse

from dcim.choices import InterfaceTypeChoices
from dcim.models import Cable, Device, DeviceRole, DeviceType, Interface, Manufacturer, Rack, Site
from utilities.testing import TestCase

from nbcableeditor.models import RackCablePlan


class RackPlanningAPITests(TestCase):
    user_permissions = (
        "dcim.view_rack", "dcim.view_device", "dcim.view_devicetype", "dcim.view_interface", "dcim.view_cable",
        "nbcableeditor.add_rackcableplan", "nbcableeditor.view_rackcableplan", "nbcableeditor.change_rackcableplan",
        "nbcableeditor.delete_rackcableplan",
    )

    @classmethod
    def setUpTestData(cls):
        site = Site.objects.create(name="Plan API site", slug="plan-api-site")
        manufacturer = Manufacturer.objects.create(name="Plan API vendor", slug="plan-api-vendor")
        device_type = DeviceType.objects.create(manufacturer=manufacturer, model="Plan switch", slug="plan-api-switch")
        role = DeviceRole.objects.create(name="Plan API role", slug="plan-api-role", color="173a71")
        cls.rack = Rack.objects.create(site=site, name="Plan API rack")
        cls.other = Rack.objects.create(site=site, name="Other plan rack")
        cls.ports = [
            Interface.objects.create(
                device=Device.objects.create(
                    device_type=device_type, role=role, site=site, rack=rack, name=name,
                    position=position, face="front",
                ), name="Ethernet1", type=InterfaceTypeChoices.TYPE_1GE_FIXED,
            )
            for rack, position, name in (
                (cls.rack, 8, "Upper"), (cls.rack, 4, "Lower"), (cls.other, 4, "Outside"),
            )
        ]

    def route(self, kind, *ids):
        return reverse(f"plugins:nbcableeditor:{kind}", args=[self.rack.pk, *ids])

    def post(self, url, action, status=200, **payload):
        response = self.client.post(url, {"action": action, **payload}, content_type="application/json")
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def create(self, name="Install switches"):
        return self.post(self.route("plans"), "create", 201, name=name)["plan"]

    def operation(self, target=1):
        return {"id": "new-one", "action": "add", "a": self.ports[0].pk, "b": self.ports[target].pk, "type": "cat6"}

    def test_lifecycle_with_reports_idempotency_and_no_implicit_length(self):
        self.add_permissions("dcim.add_cable")
        plan = self.create()
        detail = self.route("plan", plan["id"])
        plan = self.post(detail, "save", revision=0, operations=[self.operation()])["plan"]
        self.assertEqual(plan["revision"], 1)
        self.assertEqual(Cable.objects.count(), 0)
        self.post(detail, "save", 409, revision=0, name="Stale")
        duplicate = self.post(detail, "duplicate", 201, revision=1, name="Second proposal")["plan"]
        self.assertEqual(duplicate["operations"], plan["operations"])

        url = self.route("calculator")
        report = self.client.get(url, {"plan": plan["id"]}).json()["report"]
        self.assertTrue(report["details"][0]["estimated"])
        self.assertTrue(report["billOfMaterials"])
        csv = self.client.get(url, {"plan": plan["id"], "view": "bom", "format": "csv"})
        self.assertTrue(csv.content.startswith(b"\xef\xbb\xbfCable type;Standard length"))
        self.assertIn(str(report["billOfMaterials"][0]["lengthMm"]).encode(), csv.content)
        self.assertEqual(self.client.get(url, {"devices": "99", "zoom": "300", "trim": "1"}).json()["report"],
                         self.client.get(url).json()["report"])

        preview = self.post(detail, "preview", revision=1)["preview"]
        self.assertEqual(preview["report"], report)
        self.assertTrue(preview["token"])
        self.post(detail, "apply", 409, revision=1, token="not-the-preview")
        result = self.post(detail, "apply", revision=1, token=preview["token"])
        cable = Cable.objects.get(pk=result["ids"]["new-one"])
        self.assertEqual(cable.status, "planned")
        self.assertIsNone(cable.length)
        again = self.post(detail, "apply", revision=1, token=preview["token"])
        self.assertEqual(result["ids"], again["ids"])
        self.assertEqual(Cable.objects.count(), 1)
        self.post(detail, "delete", revision=result["plan"]["revision"])
        self.assertFalse(RackCablePlan.objects.filter(pk=plan["id"]).exists())
        self.assertTrue(Cable.objects.filter(pk=cable.pk).exists())

    def test_scope_permissions_and_live_occupancy(self):
        plan = self.create()
        detail = self.route("plan", plan["id"])
        self.post(detail, "save", 403, revision=0, operations=[self.operation()])
        self.add_permissions("dcim.add_cable")
        self.post(detail, "save", 404, revision=0, operations=[self.operation(target=2)])
        self.post(detail, "save", revision=0, operations=[self.operation()])
        preview = self.post(detail, "preview", revision=1)["preview"]
        Cable.objects.create(a_terminations=[self.ports[0]], b_terminations=[self.ports[2]])
        rejected = self.post(detail, "apply", 409, revision=1, token=preview["token"])
        self.assertIsNone(rejected["preview"]["token"])
        self.assertTrue(any(issue["severity"] == "error" for issue in rejected["preview"]["issues"]))
        self.assertEqual(Cable.objects.count(), 1)
        self.post(self.route("plans"), "geometry", 403, geometry={"mounting_depth_mm": 500})
        self.add_permissions("dcim.change_rack")
        self.post(self.route("plans"), "geometry", 400, geometry={"mounting_depth_mm": -10})
        result = self.post(self.route("plans"), "geometry", geometry={"mounting_depth_mm": 500})
        self.assertEqual(result["geometry"], {"mounting_depth_mm": 500})
