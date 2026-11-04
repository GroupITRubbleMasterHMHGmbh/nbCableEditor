from core.models import ObjectType
from dcim.models import Device, DeviceRole, DeviceType, Manufacturer, Module, ModuleType, Rack, Site
from django.conf import settings
from django.urls import reverse
from extras.choices import CustomFieldTypeChoices as FieldType, CustomFieldUIVisibleChoices as Visibility
from extras.models import CustomField
from utilities.testing import TestCase

from netbox_rack_editor.models import LayoutRevision


class LayoutPlaceholderTestCase(TestCase):
    user_permissions = (
        "dcim.view_device", "dcim.view_devicetype", "dcim.view_rack", "dcim.view_moduletype",
        "dcim.view_site", "dcim.view_manufacturer",
    )

    @classmethod
    def setUpTestData(cls):
        cls.site = Site.objects.create(name="Local site", slug="local-site")
        related_site = Site.objects.create(name="Related site", slug="related-site")
        role = DeviceRole.objects.create(name="Private role", slug="private-role")
        manufacturer = Manufacturer.objects.create(name="Visible maker", slug="visible-maker")
        cls.device_type = DeviceType.objects.create(manufacturer=manufacturer, model="Switch", slug="switch")
        cls.module_type = ModuleType.objects.create(manufacturer=manufacturer, model="Card")
        cls.rack = Rack.objects.create(name="Test rack", site=cls.site)
        types = ObjectType.objects.get_for_models(Device, DeviceType, Module, ModuleType, Site)
        for name, field_type, visibility, models in (
            ("building_code", FieldType.TYPE_TEXT, Visibility.ALWAYS, (Device,)),
            ("private_code", FieldType.TYPE_TEXT, Visibility.HIDDEN, (Device,)),
            ("supported", FieldType.TYPE_BOOLEAN, Visibility.IF_SET, (Device,)),
            ("related_sites", FieldType.TYPE_MULTIOBJECT, Visibility.ALWAYS, (Device,)),
            ("mounting_code", FieldType.TYPE_TEXT, Visibility.ALWAYS, (DeviceType, ModuleType)),
            ("module_note", FieldType.TYPE_TEXT, Visibility.ALWAYS, (Module,)),
        ):
            field = CustomField.objects.create(
                name=name, type=field_type, ui_visible=visibility,
                related_object_type=types[Site] if name == "related_sites" else None,
            )
            field.object_types.set([types[model] for model in models])
        cls.device_type.custom_field_data = {"mounting_code": "MT-12"}
        cls.device_type.save(update_fields=["custom_field_data"])
        Device.objects.create(
            name="Switch A", serial="SN-123", asset_tag="ASSET-42", site=cls.site, rack=cls.rack,
            role=role, device_type=cls.device_type, position=1, face="front",
            custom_field_data={
                "building_code": "BLD 8", "private_code": "Hidden secret", "supported": False,
                "related_sites": [related_site.pk, cls.site.pk],
            },
        )
        LayoutRevision.objects.create(device_type=cls.device_type, design={"front": {"useImage": False, "items": [
            {"kind": "text", "text": "{device.name} | {device.serial} | {device.role} | {device.site}",
             "x": .5, "y": .2, "font": "sans-serif", "size": 16},
            {"kind": "rectangle", "x": .2, "y": .3, "width": .4, "height": .3, "label": {
                "text": "{device.custom.building_code} | {device.type.custom.mounting_code} | "
                        "{device.custom.supported} | {device.custom.private_code} | {device.custom.related_sites}",
                "font": "serif", "size": 12, "position": "center",
            }},
        ]}})

    def test_catalog_reflects_assigned_visible_fields_for_both_layout_types(self):
        device_page = self.client.get(reverse("plugins:netbox_rack_editor:layout", args=[self.device_type.pk]))
        fields = {row["token"]: row for row in device_page.context["layout_data"]["placeholderFields"]}
        self.assertIn("device.primary_ip4", fields)
        self.assertEqual(fields["device.type"]["example"], "Switch")
        self.assertEqual(fields["device.custom.building_code"]["group"], "Device · Custom fields")
        self.assertIn("device.type.custom.mounting_code", fields)
        self.assertNotIn("device.custom.private_code", fields)
        self.assertNotIn("device.local_context_data", fields)
        self.assertNotIn("module.custom.module_note", fields)

        module_page = self.client.get(reverse("plugins:netbox_rack_editor:module-layout", args=[self.module_type.pk]))
        fields = {row["token"] for row in module_page.context["layout_data"]["placeholderFields"]}
        self.assertTrue({"device.custom.building_code", "module.bay", "module.custom.module_note",
                         "module.type.custom.mounting_code"} <= fields)

    def test_rack_only_prints_permitted_native_relations_and_custom_values(self):
        url = reverse("plugins:netbox_rack_editor:rack", args=[self.rack.pk])
        items = self.client.get(url).context["rack_data"]["devices"][0]["design"]["front"]["items"]
        self.assertEqual(items[0]["text"], "Switch A (ASSET-42) | SN-123 |  | Local site")
        self.assertEqual(items[1]["label"]["text"], "BLD 8 | MT-12 | False |  | Related site, Local site")

        self.remove_permissions("dcim.view_site")
        items = self.client.get(url).context["rack_data"]["devices"][0]["design"]["front"]["items"]
        self.assertEqual(items[0]["text"], "Switch A (ASSET-42) | SN-123 |  | ")
        self.assertEqual(items[1]["label"]["text"], "BLD 8 | MT-12 | False |  | ")

    def test_field_picker_is_english_on_a_german_netbox(self):
        self.client.cookies[settings.LANGUAGE_COOKIE_NAME] = "de"
        response = self.client.get(reverse("plugins:netbox_rack_editor:layout", args=[self.device_type.pk]))
        self.assertEqual(response.headers["Content-Language"], "de")
        fields = {row["token"]: row for row in response.context["layout_data"]["placeholderFields"]}
        self.assertEqual(fields["device.description"]["label"], "Description")
