from core.models import ObjectType
from dcim.models import DeviceRole, Rack, RackRole, Site
from django.urls import reverse
from extras.models import Tag
from users.models import ObjectPermission
from utilities.testing import TestCase

from nbcableeditor.configuration import SETTINGS_PERMISSION
from nbcableeditor.models import CableEditorSettings, GlobalRackSavedView, RackSavedView
from nbcableeditor.rack_features import TRACE_DESTINATION_FEATURES


class GlobalRackViewTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        selected_site = Site.objects.create(name="Selected site", slug="selected-site")
        other_site = Site.objects.create(name="Other site", slug="other-site")
        cls.role = RackRole.objects.create(name="Network", slug="network")
        cls.tag = Tag.objects.create(name="Technician", slug="technician")
        cls.by_site = Rack.objects.create(name="By site", site=selected_site)
        cls.by_rack = Rack.objects.create(name="By rack", site=other_site)
        cls.by_role = Rack.objects.create(name="By role", site=other_site, role=cls.role)
        cls.by_tag = Rack.objects.create(name="By tag", site=other_site)
        cls.by_tag.tags.add(cls.tag)
        cls.excluded = Rack.objects.create(name="Excluded rack", site=other_site)
        CableEditorSettings.objects.get_or_create(pk=1)

    def setUp(self):
        super().setUp()
        self.add_permissions(SETTINGS_PERMISSION, "dcim.view_site", "dcim.view_rackrole", "extras.view_tag")
        self.api = reverse("plugins:nbcableeditor:global-views-api")

    def post(self, action, status=200, **values):
        response = self.client.post(self.api, {"action": action, **values}, content_type="application/json")
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def rack_views(self, rack):
        response = self.client.get(reverse("plugins:nbcableeditor:rack-saved-views", args=[rack.pk]))
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["views"]

    def test_preview_and_rack_picker_apply_the_same_scope(self):
        self.add_permissions("dcim.view_rack")
        scope = {
            "all": False, "sites": [self.by_site.site_id], "racks": [self.by_rack.pk],
            "roles": [self.role.pk], "tags": [self.tag.pk],
        }
        selected = [self.by_rack, self.by_role, self.by_site, self.by_tag]
        preview = self.post("preview", scope=scope)
        self.assertEqual(preview["count"], 4)
        self.assertEqual([rack["id"] for rack in preview["racks"]], [rack.pk for rack in selected])
        settings = {
            "display": {"lines": "filtered", "externalLocations": False, "traceOtherSites": True},
            "connectionFilter": {"kind": "group", "operator": "and", "children": [
                {"kind": "trace", "scope": "end-outside-site", "values": [], "negated": True},
            ]},
            "portFilter": {"kind": "group", "operator": "and", "children": [
                {"kind": "endpoint", "endpoint": "any", "criteria": {"portRanges": "1-24"}},
            ]},
            "portFilterAction": "mark",
            "toolbar": {"export": False},
        }
        saved = self.post("create", 201, name="Technician view", scope=scope, settings=settings)
        global_id = f'global-{saved["viewId"]}'
        RackSavedView.objects.create(pk=saved["viewId"], rack=self.by_site, name="Local view", is_default=True)
        designer = self.client.get(reverse("plugins:nbcableeditor:global-views"))
        self.assertContains(designer, "Technician view")
        self.assertEqual(designer.context["designer"]["views"][0]["scope"], scope)
        self.assertEqual(designer.context["designer"]["traceDestinationFeatures"], TRACE_DESTINATION_FEATURES)
        self.remove_permissions(SETTINGS_PERMISSION)
        self.post("preview", 403, scope=scope)
        for rack in selected:
            view = next(view for view in self.rack_views(rack) if view["id"] == global_id)
            self.assertEqual(view["settings"], settings)
            self.assertTrue(view["isGlobal"])
            self.assertFalse(view["isDefault"])
        self.assertEqual(self.rack_views(self.excluded), [])
        self.assertEqual(self.rack_views(self.by_site)[0]["id"], saved["viewId"])

    def test_preview_only_lists_readable_racks_and_rejects_inaccessible_scope_targets(self):
        permission = ObjectPermission.objects.create(
            name="One readable rack", actions=["view"], constraints={"pk": self.by_site.pk},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(Rack))
        permission.users.add(self.user)
        preview = self.post("preview", scope={"all": True})
        self.assertEqual(preview["count"], 1)
        self.assertEqual([rack["id"] for rack in preview["racks"]], [self.by_site.pk])
        self.post("create", 403, name="Inaccessible", scope={"all": False, "racks": [self.by_rack.pk]}, settings={})
        self.assertFalse(GlobalRackSavedView.objects.exists())

    def test_toolbar_options_and_effective_default_follow_rack_scope_and_order(self):
        self.add_permissions("dcim.view_rack")
        later = self.post("create", 201, name="Zebra", scope={"all": True}, settings={},
                          showInToolbar=True, isDefault=True)
        scoped = self.post("create", 201, name="alpha", scope={"all": False, "racks": [self.by_site.pk]},
                           settings={}, showInToolbar=False, isDefault=True)
        hidden = self.post("create", 201, name="Aardvark", scope={"all": True}, settings={})

        def global_key(result):
            return f'global-{result["viewId"]}'

        self.assertEqual([(view["name"], view["showInToolbar"], view["isDefault"]) for view in scoped["views"]],
                         [("alpha", False, True), ("Zebra", True, True)])
        self.assertEqual([(view["id"], view["showInToolbar"], view["isDefault"])
                          for view in self.rack_views(self.by_site)],
                         [(global_key(hidden), False, False), (global_key(scoped), False, True),
                          (global_key(later), True, False)])
        self.assertEqual([view["id"] for view in self.rack_views(self.by_rack) if view["isDefault"]],
                         [global_key(later)])

        local = RackSavedView.objects.create(rack=self.by_site, name="Local override", is_default=True)
        self.assertEqual([view["id"] for view in self.rack_views(self.by_site) if view["isDefault"]], [local.pk])
        local.delete()
        self.assertEqual([view["id"] for view in self.rack_views(self.by_site) if view["isDefault"]],
                         [global_key(scoped)])

        updated = self.post("save", id=scoped["viewId"], revision=0, name="alpha",
                            scope={"all": False, "racks": [self.by_site.pk]}, settings={},
                            showInToolbar=True, isDefault=False)
        self.assertEqual([(view["id"], view["showInToolbar"], view["isDefault"])
                          for view in self.rack_views(self.by_site) if view["showInToolbar"]],
                         [(global_key(scoped), True, False), (global_key(later), True, True)])
        self.assertEqual(updated["views"][1]["revision"], 1)

    def test_global_view_options_validate_booleans_and_preserve_unsent_fields(self):
        self.post("create", 400, name="Invalid default", scope={"all": True}, settings={}, isDefault=1)
        self.post("create", 400, name="Invalid toolbar", scope={"all": True}, settings={}, showInToolbar="true")
        self.assertFalse(GlobalRackSavedView.objects.exists())
        view = self.post("create", 201, name="Original", scope={"all": True}, settings={},
                         isDefault=True, showInToolbar=True)["views"][0]
        result = self.post("save", id=view["id"], revision=view["revision"], name="Renamed",
                           scope={"all": True}, settings={})["views"][0]
        self.assertTrue(result["isDefault"])
        self.assertTrue(result["showInToolbar"])

    def test_filter_catalog_and_read_only_rack_preview_require_readable_rack(self):
        permission = ObjectPermission.objects.create(
            name="One filter preview rack", actions=["view"], constraints={"pk": self.by_site.pk},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(Rack))
        permission.users.add(self.user)
        empty = self.post("filter-catalog")
        self.assertIsNone(empty["rackId"])
        self.assertIsNone(empty["previewUrl"])
        self.assertTrue(empty["cableTypes"])
        self.post("filter-catalog", 400, rackId="invalid")
        self.post("filter-catalog", 404, rackId=self.by_rack.pk)
        catalog = self.post("filter-catalog", rackId=self.by_site.pk)
        self.assertEqual(catalog["rackId"], self.by_site.pk)
        self.assertEqual(catalog["siteId"], self.by_site.site_id)
        self.assertEqual(catalog["devices"], [])
        self.assertEqual(catalog["cables"], [])

        response = self.client.get(catalog["previewUrl"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["X-Frame-Options"], "SAMEORIGIN")
        self.assertTrue(response.context["global_view_preview"])
        rack_data = response.context["rack_data"]
        self.assertTrue(rack_data["globalViewPreview"])
        self.assertFalse(any(rack_data[key] for key in ("canAdd", "canChange", "canDelete")))
        self.assertFalse(rack_data["settings"]["features"]["savedViews"])
        self.assertEqual(self.client.get(reverse(
            "plugins:nbcableeditor:global-views-rack-preview", args=[self.by_rack.pk],
        )).status_code, 404)

        self.remove_permissions(SETTINGS_PERMISSION)
        self.post("filter-catalog", 403)
        self.assertEqual(self.client.get(catalog["previewUrl"]).status_code, 403)

    def test_filter_choices_are_searchable_globally_and_limit_results_to_permissions(self):
        permitted = DeviceRole.objects.create(name="Core Switch", slug="core-switch")
        restricted = DeviceRole.objects.create(name="Edge Switch", slug="edge-switch")
        permission = ObjectPermission.objects.create(
            name="One filter device role", actions=["view"], constraints={"pk": permitted.pk},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(DeviceRole))
        permission.users.add(self.user)
        expected = {"choices": [[permitted.pk, f"Core Switch (#{permitted.pk})"]], "hasMore": False}
        self.assertEqual(self.post("filter-choices", field="deviceRoles", query="switch"), expected)
        self.assertEqual(self.post("filter-choices", field="deviceRoles", ids=[permitted.pk, restricted.pk]), expected)
        self.post("filter-choices", 400, field="deviceRoles", ids=[True])
        self.post("filter-choices", 400, field="unknown")

    def test_revision_conflicts_and_removing_a_target_do_not_broaden_scope(self):
        self.add_permissions("dcim.view_rack")
        self.post("create", 400, name="Missing targets", scope={"all": False}, settings={})
        payload = self.post("create", 201, name="Original", scope={"all": True}, settings={})
        view = payload["views"][0]
        self.assertEqual(len(self.rack_views(self.by_site)), 1)
        updated = self.post("save", id=view["id"], revision=view["revision"], name="Renamed",
                            scope={"all": False, "racks": [self.by_rack.pk]}, settings={})
        self.post("delete", 409, id=view["id"], revision=view["revision"])
        self.by_rack.delete()
        self.assertEqual(self.rack_views(self.by_site), [])
        self.post("delete", id=view["id"], revision=updated["views"][0]["revision"])
        self.assertFalse(GlobalRackSavedView.objects.exists())
