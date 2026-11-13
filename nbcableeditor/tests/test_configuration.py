from types import SimpleNamespace

from core.models import ObjectType
from dcim.models import Cable, Rack, Site
from django.test import Client, override_settings
from django.urls import reverse
from extras.models import CustomField
from users.models import ObjectPermission
from utilities.testing import TestCase

from nbcableeditor.calculator import DEFAULT_PROFILE_NAME, configured_calculator
from nbcableeditor.configuration import (
    SETTINGS_PERMISSION, SETTINGS_ROUTE, CableEditorSettingsForm, cable_custom_values, nbcableeditor_options,
)
from nbcableeditor.models import CableEditorSettings
from nbcableeditor.rack_features import RACK_FEATURE_LABELS, TRACE_DESTINATION_FEATURES, VIEW_TOOLBAR_FEATURES


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

    @override_settings(LOGIN_REQUIRED=True, EXEMPT_VIEW_PERMISSIONS=["dcim.rack"])
    def test_editor_requires_login_even_when_rack_view_is_exempt(self):
        url = reverse("plugins:nbcableeditor:rack", args=[self.rack.pk])
        response = Client().get(url)
        self.assertRedirects(response, f"{reverse('login')}?next={url}", fetch_redirect_response=False)
        self.assertIn("no-store", response.headers["Cache-Control"])

    @override_settings(LOGIN_REQUIRED=False, EXEMPT_VIEW_PERMISSIONS=["dcim.rack"])
    def test_explicitly_public_rack_view_remains_available(self):
        url = reverse("plugins:nbcableeditor:rack", args=[self.rack.pk])
        self.assertEqual(Client().get(url).status_code, 200)

    def test_rack_html_and_plan_json_are_not_cacheable(self):
        for endpoint in ("rack", "plans"):
            with self.subTest(endpoint=endpoint):
                response = self.client.get(reverse(f"plugins:nbcableeditor:{endpoint}", args=[self.rack.pk]))
                self.assertEqual(response.status_code, 200)
                self.assertIn("private", response.headers["Cache-Control"])
                self.assertIn("no-store", response.headers["Cache-Control"])

    def test_settings_post_requires_csrf_token(self):
        self.add_permissions(SETTINGS_PERMISSION)
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user)
        response = client.post(reverse(SETTINGS_ROUTE), self.default_form_data())
        self.assertEqual(response.status_code, 403)
        self.assertEqual(CableEditorSettings.objects.get().options, {})

    def test_configuration_permission_respects_object_constraints(self):
        permission = ObjectPermission.objects.create(
            name="Settings excluded by constraint", actions=["change"], constraints={"pk": 2},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(CableEditorSettings))
        permission.users.add(self.user)
        self.assertEqual(self.client.get(reverse(SETTINGS_ROUTE)).status_code, 403)

    def test_configuration_change_cannot_move_settings_outside_permitted_scope(self):
        original = {"face": "front"}
        CableEditorSettings.objects.filter(pk=1).update(options=original)
        permission = ObjectPermission.objects.create(
            name="Only front-facing settings", actions=["change"], constraints={"options__face": "front"},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(CableEditorSettings))
        permission.users.add(self.user)
        url = reverse(SETTINGS_ROUTE)
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self.client.post(url, {**self.default_form_data(), "face": "rear"}).status_code, 403)
        self.assertEqual(CableEditorSettings.objects.get().options, original)

    def test_save_validated_settings_and_deliver_them_to_rack_viewers(self):
        self.add_permissions(SETTINGS_PERMISSION)
        url = reverse(SETTINGS_ROUTE)
        settings_page = self.client.get(url)
        self.assertContains(settings_page, "Default port contour")
        self.assertContains(settings_page, "Show external cable locations")
        for label in TRACE_DESTINATION_FEATURES.values():
            self.assertContains(settings_page, label)
        values = self.default_form_data()
        values.update(face="rear", zoom="1.5", cableGap=6.5, portBorderConnected=4, directoryFields=[], connections=False,
                      externalLocations=True, traceOtherLocations=True, traceUnrackedDevices=True)
        self.assertRedirects(self.client.post(url, values), url)
        saved = CableEditorSettings.objects.get()
        self.assertEqual(saved.options["cableGap"], 6.5)
        self.assertEqual(saved.options["portBorderConnected"], 4)
        self.assertFalse(saved.options["connections"])
        self.assertTrue(saved.options["externalLocations"])
        self.remove_permissions(SETTINGS_PERMISSION)
        rack_url = reverse("plugins:nbcableeditor:rack", args=[self.rack.pk])
        response = self.client.get(rack_url)
        settings = response.context["rack_data"]["settings"]
        self.assertEqual((settings["face"], settings["zoom"]), ("rear", "1.5"))
        self.assertEqual(settings["display"]["directoryFields"], [])
        self.assertTrue(settings["externalLocations"])
        self.assertEqual(
            {key: settings[key] for key in TRACE_DESTINATION_FEATURES},
            {"traceOtherRacks": False, "traceOtherLocations": True, "traceOtherSites": False, "traceUnrackedDevices": True},
        )
        self.assertContains(response, "data-view-external-locations")
        for suffix in ("other-racks", "other-locations", "other-sites", "unracked-devices"):
            self.assertContains(response, f"data-view-trace-{suffix}")
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

    def test_zoom_relabels_the_reference_and_retains_an_existing_fixed_scale(self):
        form = CableEditorSettingsForm(initial={"zoom": "1.5"}, custom_fields=[])
        choices = dict(form.fields["zoom"].choices)
        self.assertEqual(choices["1.75"], "100%")
        self.assertEqual(choices["1.5"], "86%")
        self.assertEqual(form["zoom"].value(), "1.5")

    def test_rack_feature_configuration_defaults_and_preserves_older_form_posts(self):
        defaults, _ = nbcableeditor_options()
        self.assertTrue(all(defaults["features"].values()))
        self.assertTrue(all(defaults["toolbarDefaults"].values()))
        self.assertFalse(defaults["externalLocations"])
        self.assertFalse(any(defaults[key] for key in TRACE_DESTINATION_FEATURES))
        self.add_permissions(SETTINGS_PERMISSION)
        url = reverse(SETTINGS_ROUTE)
        form_page = self.client.get(url)
        self.assertContains(form_page, "Rack features")
        self.assertContains(form_page, "Default rack toolbar")
        self.assertEqual(form_page.context["form"].initial["features"], list(RACK_FEATURE_LABELS))
        self.assertEqual(form_page.context["form"].initial["toolbarDefaults"], list(VIEW_TOOLBAR_FEATURES))
        values = self.default_form_data()
        values.update(face="rear", features=["calculator", "zoom"], rackFeatureControls="1",
                      toolbarDefaults=["devices", "zoom"], rackToolbarControls="1")
        self.assertRedirects(self.client.post(url, values), url)
        stored = CableEditorSettings.objects.get().options
        self.assertEqual(stored["features"], {key: key in {"calculator", "zoom"} for key in RACK_FEATURE_LABELS})
        self.assertEqual(stored["toolbarDefaults"], {key: key in {"devices", "zoom"} for key in VIEW_TOOLBAR_FEATURES})
        self.assertEqual(stored["face"], "rear")
        data = self.client.get(reverse("plugins:nbcableeditor:rack", args=[self.rack.pk])).context["rack_data"]
        self.assertEqual(data["settings"]["face"], "front")
        self.assertEqual(data["settings"]["featureLabels"], RACK_FEATURE_LABELS)
        self.assertEqual(data["settings"]["toolbarDefaults"], stored["toolbarDefaults"])
        self.assertFalse(data["settings"]["features"]["externalLocations"])
        self.assertIsNone(data["savedViews"])
        self.assertIsNone(data["planning"]["url"])
        self.assertIsNotNone(data["planning"]["reportUrl"])
        self.assertIsNone(data["history"])

        del values["features"], values["rackFeatureControls"], values["toolbarDefaults"], values["rackToolbarControls"]
        self.assertRedirects(self.client.post(url, values), url)
        self.assertEqual(CableEditorSettings.objects.get().options["features"], stored["features"])
        self.assertEqual(CableEditorSettings.objects.get().options["toolbarDefaults"], stored["toolbarDefaults"])
        self.assertRedirects(self.client.post(url, {**values, "rackToolbarControls": "1"}), url)
        self.assertFalse(any(CableEditorSettings.objects.get().options["toolbarDefaults"].values()))
        self.assertEqual(CableEditorSettings.objects.get().options["features"], stored["features"])
        self.assertRedirects(self.client.post(url, {**values, "rackFeatureControls": "1"}), url)
        self.assertFalse(any(CableEditorSettings.objects.get().options["features"].values()))

    def test_disabled_history_and_batch_workflows_are_rejected(self):
        CableEditorSettings.objects.filter(pk=1).update(options={
            "features": {"history": False, "quickConnect": False, "unplug": False},
        })
        url = reverse("plugins:nbcableeditor:cables", args=[self.rack.pk])
        for payload in (
            {"action": "history", "target": 0, "revision": 0},
            {"action": "batch", "operations": [{"cable_id": None, "source": 1, "target": 2}]},
            {"action": "batch", "operations": [{"action": "delete", "cable_id": 1}]},
        ):
            with self.subTest(action=payload):
                response = self.client.post(url, payload, content_type="application/json")
                self.assertEqual(response.status_code, 403)
                self.assertIn("disabled", response.json()["error"])

    def test_create_named_calculator_profile_and_save_catalog_independently(self):
        self.add_permissions(SETTINGS_PERMISSION)
        url = reverse(SETTINGS_ROUTE)
        response = self.client.get(url, {"new_calculator_profile": 1})
        self.assertContains(response, "Cable Calculator")
        form = response.context["profile_form"]
        values = {form.add_prefix(key): value for key, value in form.initial.items() if value is not None}
        values.update({
            "calculatorAction": "save-profile", "profile-name": "Fiber and copper", "profile-reserve_percent": 22.5,
            "profile-radius-mmf-om4": 40, "profile-set_default": "on",
        })
        self.assertEqual(self.client.post(url, values).status_code, 302)
        self.assertEqual(configured_calculator()["defaultProfile"], "Fiber and copper")
        profiles = configured_calculator()["profiles"]
        self.assertEqual(profiles["Fiber and copper"]["reserve_percent"], 22.5)
        self.assertEqual(profiles["Fiber and copper"]["bend_radius_mm"]["mmf-om4"], 40)
        self.assertIn(DEFAULT_PROFILE_NAME, profiles)

        self.assertEqual(self.client.post(url, {"calculatorAction": "save-catalog", "catalog-cat6": "1.5, 0.25, 1.50"})
                         .status_code, 302)
        self.assertEqual(configured_calculator()["catalog"], {"cat6": [250, 1500]})
        response = self.client.post(url, {"calculatorAction": "save-catalog", "catalog-cat6": "0, invalid"})
        self.assertIn("cat6", response.context["catalog_form"].errors)
        self.assertEqual(configured_calculator()["catalog"], {"cat6": [250, 1500]})
        self.assertRedirects(self.client.post(url, self.default_form_data()), url)
        self.assertEqual(configured_calculator()["profiles"], profiles)

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
