import json
from importlib.resources import files

from core.models import ObjectType
from dcim.models import DeviceType, Manufacturer
from django.urls import reverse
from users.models import ObjectPermission
from utilities.testing import TestCase

from nbcableeditor.layout_catalog import _suggestion, templates_for
from nbcableeditor.models import LayoutRevision


class LayoutCatalogTestCase(TestCase):
    user_permissions = ("dcim.view_devicetype",)

    @classmethod
    def setUpTestData(cls):
        manufacturer = Manufacturer.objects.create(name="Aruba", slug="aruba")
        cls.exact = DeviceType.objects.create(
            manufacturer=manufacturer, model="Lab 48-port Switch", slug="lab-48", part_number="jl676a",
        )
        cls.ambiguous = DeviceType.objects.create(
            manufacturer=manufacturer, model="5406R zl2", slug="5406r-zl2",
        )
        cls.conflicting = DeviceType.objects.create(
            manufacturer=manufacturer, model="Aruba 6000-12G-POE4-2SFP", slug="compact-switch", part_number="R8N89B",
        )
        cls.model = DeviceType.objects.create(
            manufacturer=manufacturer, model="6100-48G-4SFP+", slug="6100-48g-4sfp-plus",
        )
        LayoutRevision.objects.create(device_type=cls.exact, revision=1)

    def _permission(self, action, devices):
        permission = ObjectPermission.objects.create(
            name=f"Scoped {action}", actions=[action], constraints={"pk__in": [device.pk for device in devices]},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(DeviceType))
        permission.users.add(self.user)

    def test_catalog_registers_each_shipped_asset_for_its_kind(self):
        directory = files("nbcableeditor").joinpath("static", "nbcableeditor", "layout-templates")
        expected = {"device": set(), "module": set()}
        for asset in directory.iterdir():
            if asset.name.endswith(".json") and asset.name != "layout-template.schema.json":
                value = json.loads(asset.read_text(encoding="utf-8"))
                expected[value["kind"]].add(asset.name.removesuffix(".json"))
        for kind, slugs in expected.items():
            self.assertTrue(slugs)
            self.assertEqual({template.slug for template in templates_for(kind)}, slugs)

    def test_suggestion_prefers_part_number_and_leaves_conflicts_open(self):
        templates = templates_for("device")
        for device, slug in ((self.exact, "aruba-6100-48g-4sfp-plus"), (self.model, "aruba-6100-48g-4sfp-plus")):
            with self.subTest(device=device):
                self.assertEqual(_suggestion(device, templates)[0].slug, slug)
        self.assertIsNone(_suggestion(self.ambiguous, templates)[0])
        self.assertIsNone(_suggestion(self.conflicting, templates)[0])

    def test_overview_search_saved_status_and_object_permissions(self):
        self.remove_permissions("dcim.view_devicetype")
        self._permission("view", (self.exact, self.ambiguous))
        self._permission("change", (self.exact, self.conflicting))
        url = reverse("plugins:nbcableeditor:layout-imports")
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        cards = {card["device"].pk: card for card in response.context["cards"]}
        self.assertEqual(cards.keys(), {self.exact.pk, self.ambiguous.pk})
        self.assertTrue(cards[self.exact.pk]["device"].can_import)
        self.assertTrue(cards[self.exact.pk]["device"].saved_layout)
        self.assertFalse(cards[self.ambiguous.pk]["device"].can_import)
        self.assertFalse(cards[self.ambiguous.pk]["device"].saved_layout)
        self.assertNotContains(response, self.conflicting.model)

        filtered = self.client.get(url, {"q": "JL676A"})
        self.assertEqual([card["device"].pk for card in filtered.context["cards"]], [self.exact.pk])
        self.assertContains(filtered, "Review mapping")
        self.assertContains(filtered, "Layout saved")
