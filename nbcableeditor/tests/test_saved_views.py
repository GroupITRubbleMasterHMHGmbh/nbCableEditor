from core.models import ObjectType
from dcim.models import Rack, Site
from django.contrib.auth import get_user_model
from django.test import Client
from django.urls import reverse
from users.models import ObjectPermission
from utilities.testing import TestCase

from nbcableeditor.models import CableEditorSettings, RackSavedView


class RackSavedViewsTests(TestCase):
    user_permissions = ("dcim.view_rack", "dcim.change_rack")

    @classmethod
    def setUpTestData(cls):
        site = Site.objects.create(name="View site", slug="view-site")
        cls.rack = Rack.objects.create(site=site, name="View rack")
        cls.other_rack = Rack.objects.create(site=site, name="Other view rack")

    def route(self, rack=None):
        return reverse("plugins:nbcableeditor:rack-saved-views", args=[(rack or self.rack).pk])

    def post(self, action, status=200, *, rack=None, client=None, **payload):
        client = client or self.client
        response = client.post(self.route(rack), {"action": action, **payload}, content_type="application/json")
        self.assertEqual(response.status_code, status, response.content)
        return response.json() if status != 404 else None

    def create(self, name, *, rack=None, settings=None, is_default=False):
        payload = self.post("create", 201, rack=rack, name=name, settings=settings or {}, isDefault=is_default)
        return next(view for view in payload["views"] if view["id"] == payload["viewId"])

    def test_view_settings_are_shared_with_other_users_and_read_only_for_rack_viewers(self):
        settings = {
            "display": {"lines": "filtered", "routingStrategy": "pcb", "vlanColors": {
                "rules": [{"ids": "42,45-50", "color": "#00ff00"}], "fallback": "",
            }},
            "rack": {"devices": "1,2", "hiddenRows": "1:front:1", "deviceGaps": {"12:12": 75}, "vlanKind": "any"},
            "listFields": {"connection:length": True},
            "selectedConnections": [4, 9],
            "toolbar": {"devices": False, "planning": False, "export": True},
            "connectionFilter": {"kind": "group", "operator": "and", "children": [
                {"kind": "between", "directional": False,
                 "a": {"devices": [], "deviceTypes": [3], "portRanges": "1-12"},
                 "b": {"devices": [1, 2], "deviceTypes": [], "portRanges": ""}},
                {"kind": "group", "operator": "or", "children": [
                    {"kind": "vlan", "endpoint": "any", "membership": "untagged", "ids": "42"},
                    {"kind": "length", "min": 1.5, "max": 4},
                ]},
            ]},
        }
        view = self.create("Cabling technician", settings=settings, is_default=True)
        viewer = get_user_model().objects.create_user(username="rack-viewer")
        permission = ObjectPermission.objects.create(
            name="View only this rack", actions=["view"], constraints={"pk": self.rack.pk},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(Rack))
        permission.users.add(viewer)
        viewer_client = Client()
        viewer_client.force_login(viewer)

        self.assertEqual(viewer_client.get(self.route()).json(), {"views": [view]})
        self.assertEqual(view["settings"], settings)
        self.assertEqual(viewer_client.get(self.route(self.other_rack)).status_code, 404)
        self.post("save", 403, client=viewer_client, id=view["id"], revision=view["revision"], isDefault=False)
        self.post("delete", 403, client=viewer_client, id=view["id"], revision=view["revision"])
        self.post("create", 403, client=viewer_client, name="Read only", settings={})

    def test_default_is_unique_per_rack_and_stale_updates_do_not_overwrite(self):
        first = self.create("Install", is_default=True)
        second = self.create("Maintain")
        other = self.create("Install", rack=self.other_rack, is_default=True)
        self.post("create", 409, name="  install  ", settings={}, isDefault=True)
        self.assertEqual(RackSavedView.objects.get(pk=first["id"]).revision, first["revision"])
        self.assertTrue(RackSavedView.objects.get(pk=first["id"]).is_default)

        switched = self.post("save", id=second["id"], revision=second["revision"], isDefault=True)
        self.assertEqual([view["id"] for view in switched["views"] if view["isDefault"]], [second["id"]])
        self.assertTrue(RackSavedView.objects.get(pk=other["id"]).is_default)
        self.post("save", 409, id=first["id"], revision=first["revision"], isDefault=True)
        self.post("delete", 404, rack=self.other_rack, id=second["id"], revision=second["revision"] + 1)
        self.post("delete", id=second["id"], revision=second["revision"] + 1)
        self.assertEqual(RackSavedView.objects.filter(rack=self.rack, is_default=True).count(), 0)

    def test_invalid_settings_are_rejected_without_touching_the_default(self):
        view = self.create("Default", is_default=True)
        nested_filter = {"kind": "group", "operator": "and", "children": []}
        for _ in range(9):
            nested_filter = {"kind": "group", "operator": "and", "children": [nested_filter]}
        for settings in (
            {"display": {"lines": "invalid"}},
            {"rack": {"deviceGaps": {"12:12": 241}}},
            {"selectedConnections": [True]},
            {"toolbar": {"devices": "off"}},
            {"toolbar": {"unknown": False}},
            {"toolbar": {"savedViews": False}},
            {"connectionFilter": nested_filter},
        ):
            self.post("create", 400, name="Invalid", settings=settings, isDefault=True)
        self.assertEqual(self.client.get(self.route()).json(), {"views": [view]})

    def test_globally_disabled_views_remain_saved_and_are_unavailable(self):
        view = self.create("Default", is_default=True)
        CableEditorSettings.objects.update_or_create(pk=1, defaults={"options": {"features": {"savedViews": False}}})
        self.assertEqual(self.client.get(self.route()).status_code, 403)
        self.post("delete", 403, id=view["id"], revision=view["revision"])
        self.assertTrue(RackSavedView.objects.get(pk=view["id"]).is_default)
        CableEditorSettings.objects.filter(pk=1).update(options={})
        self.assertEqual(self.client.get(self.route()).json(), {"views": [view]})
