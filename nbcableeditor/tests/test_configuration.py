from types import SimpleNamespace

from core.models import ObjectType
from dcim.models import Cable, Rack, Site
from django.urls import reverse
from extras.models import CustomField
from users.models import ObjectPermission
from utilities.testing import TestCase

from nbcableeditor.configuration import (
    SETTINGS_PERMISSION, SETTINGS_ROUTE, CableEditorSettingsForm, cable_custom_values, nbcableeditor_options,
)
from nbcableeditor.models import CableEditorSettings


class CableEditorSettingsTest(TestCase):
    user_permissions = ("dcim.view_rack",)

    @classmethod
    def setUpTestData(cls):
        site = Site.objects.create(name="Editor settings site", slug="editor-settings-site")
        cls.rack = Rack.objects.create(site=site, name="Settings rack")
        CableEditorSettings.objects.get_or_create(pk=1)

    def default_form_data(self):
        return {key: field.initial for key, field in CableEditorSettingsForm.base_fields.items() if field.initial is not None}

    def test_configuration_requires_permission(self):
        url = reverse(SETTINGS_ROUTE)
        self.assertEqual(self.client.get(url).status_code, 403)
        self.assertEqual(self.client.post(url, self.default_form_data()).status_code, 403)
        self.assertEqual(CableEditorSettings.objects.get().options, {})

    def test_configuration_permission_respects_object_constraints(self):
        permission = ObjectPermission.objects.create(
            name="Settings excluded by constraint", actions=["change"], constraints={"pk": 2},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(CableEditorSettings))
        permission.users.add(self.user)
        self.assertEqual(self.client.get(reverse(SETTINGS_ROUTE)).status_code, 403)

    def test_save_validated_settings_and_deliver_them_to_rack_viewers(self):
        self.add_permissions(SETTINGS_PERMISSION)
        url = reverse(SETTINGS_ROUTE)
        self.assertContains(self.client.get(url), "Default port contour")
        values = self.default_form_data()
        values.update(face="rear", zoom="1.5", cableGap=6.5, portBorderConnected=4, directoryFields=[], connections=False)
        self.assertRedirects(self.client.post(url, values), url)
        saved = CableEditorSettings.objects.get()
        self.assertEqual(saved.options["cableGap"], 6.5)
        self.assertEqual(saved.options["portBorderConnected"], 4)
        self.assertFalse(saved.options["connections"])
        self.remove_permissions(SETTINGS_PERMISSION)
        rack_url = reverse("plugins:nbcableeditor:rack", args=[self.rack.pk])
        response = self.client.get(rack_url)
        settings = response.context["rack_data"]["settings"]
        self.assertEqual((settings["face"], settings["zoom"]), ("rear", "1.5"))
        self.assertEqual(settings["display"]["directoryFields"], [])
        self.assertFalse(response.context["can_manage_editor_settings"])

    def test_invalid_clearances_do_not_replace_saved_settings(self):
        self.add_permissions(SETTINGS_PERMISSION)
        original = {"zoom": "2"}
        CableEditorSettings.objects.filter(pk=1).update(options=original)
        values = self.default_form_data()
        values.update(tubeGap=25, tubeParallelGap=12, cableGap=21)
        response = self.client.post(reverse(SETTINGS_ROUTE), values)
        self.assertIn("tubeParallelGap", response.context["form"].errors)
        self.assertIn("cableGap", response.context["form"].errors)
        self.assertEqual(CableEditorSettings.objects.get().options, original)

    def test_zoom_defaults_and_legacy_horizontal_fit(self):
        self.assertEqual(nbcableeditor_options()[0]["zoom"], "auto")
        CableEditorSettings.objects.filter(pk=1).update(options={"zoom": "fit"})
        self.assertEqual(nbcableeditor_options()[0]["zoom"], "horizontal-fit")
        self.assertEqual(CableEditorSettings.objects.get().options["zoom"], "fit")

    def test_only_selected_visible_cable_custom_fields_are_serialized(self):
        object_type = ObjectType.objects.get_for_model(Cable)
        fields = [
            CustomField.objects.create(name="order_ref", label="Order reference", type="text"),
            CustomField.objects.create(name="spare", type="boolean", ui_visible="if-set"),
            CustomField.objects.create(name="hidden_ref", type="text", ui_visible="hidden"),
            CustomField.objects.create(name="unselected", type="text"),
            CustomField.objects.create(
                name="related_rack", type="object", related_object_type=ObjectType.objects.get_for_model(Rack),
            ),
        ]
        for field in fields:
            field.object_types.add(object_type)
        CableEditorSettings.objects.filter(pk=1).update(options={
            "cableCustomFields": ["order_ref", "spare", "hidden_ref", "related_rack"],
        })
        options, selected = nbcableeditor_options()
        self.assertEqual(options["display"]["cableCustomFieldLabels"]["order_ref"], "Order reference")
        cable = SimpleNamespace(pk=1, custom_field_data={
            "order_ref": "ORD-1", "spare": False, "hidden_ref": "internal", "unselected": "other",
            "related_rack": self.rack.pk,
        })
        expected = {"order_ref": "ORD-1", "spare": False, "related_rack": self.rack.name}
        self.assertEqual(cable_custom_values(self.user, [cable], selected), {1: expected})
        self.remove_permissions("dcim.view_rack")
        del expected["related_rack"]
        self.user.refresh_from_db()
        self.assertEqual(cable_custom_values(type(self.user).objects.get(pk=self.user.pk), [cable], selected), {1: expected})
