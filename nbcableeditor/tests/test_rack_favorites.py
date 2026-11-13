from core.models import ObjectType
from dcim.choices import RackStatusChoices
from dcim.models import Device, DeviceRole, DeviceType, Location, Manufacturer, Rack, RackRole, Site, SiteGroup
from django.contrib.auth import get_user_model
from django.urls import reverse
from extras.models import Tag
from tenancy.models import Tenant
from users.models import ObjectPermission
from utilities.testing import TestCase

from nbcableeditor.models import FavoriteRack, GlobalRackSavedView, RackSavedView


class RackFavoritesTests(TestCase):
    user_permissions = (
        "dcim.view_rack", "dcim.view_site", "dcim.view_sitegroup", "dcim.view_location",
        "dcim.view_device", "dcim.view_rackrole", "tenancy.view_tenant", "extras.view_tag",
    )

    @classmethod
    def setUpTestData(cls):
        cls.group = SiteGroup.objects.create(name="East", slug="east")
        group_child = SiteGroup.objects.create(name="East labs", slug="east-labs", parent=cls.group)
        cls.site = Site.objects.create(name="East site", slug="east-site", group=group_child)
        other_site = Site.objects.create(name="West site", slug="west-site")
        cls.location = Location.objects.create(name="Building", slug="building", site=cls.site)
        room = Location.objects.create(name="Server room", slug="server-room", site=cls.site, parent=cls.location)
        cls.role = RackRole.objects.create(name="Backbone", slug="backbone")
        cls.tenant = Tenant.objects.create(name="IT Operations", slug="it-operations")
        cls.tag = Tag.objects.create(name="Rack audit", slug="rack-audit")
        cls.rack = Rack.objects.create(name="Rack A", site=cls.site, location=room, tenant=cls.tenant, role=cls.role,
                                       u_height=48)
        cls.other = Rack.objects.create(name="Rack B", site=other_site, u_height=24,
                                        status=RackStatusChoices.STATUS_RESERVED)
        cls.rack.tags.add(cls.tag)
        manufacturer = Manufacturer.objects.create(name="Acme", slug="acme")
        model = DeviceType.objects.create(manufacturer=manufacturer, model="Switch", slug="switch")
        role = DeviceRole.objects.create(name="Switch", slug="switch")
        cls.device = Device.objects.create(name="Switch 1", site=cls.site, rack=cls.rack, device_type=model, role=role)
        cls.owner = get_user_model().objects.create_user(username="other-favorites-user")
        cls.local = RackSavedView.objects.create(rack=cls.rack, name="Rack technician")
        cls.default = RackSavedView.objects.create(rack=cls.rack, name="Starting view", is_default=True)
        cls.global_view = GlobalRackSavedView.objects.create(name="Group technician")
        cls.global_view.tags.add(cls.tag)

    def setUp(self):
        super().setUp()
        self.url = reverse("plugins:nbcableeditor:my-racks")

    def test_catalog_filters_all_requested_fields_and_matches_nested_groups(self):
        for key, value in {
            "name": "Rack A", "site": self.site.pk, "location": self.location.pk, "role": self.role.pk,
            "status": RackStatusChoices.STATUS_ACTIVE, "tenant": self.tenant.pk, "tag": self.tag.pk,
            "device_count": 1, "height": 48, "group": self.group.pk,
        }.items():
            with self.subTest(filter=key):
                response = self.client.get(self.url, {key: value})
                self.assertEqual(response.status_code, 200)
                self.assertEqual([item["rack"].pk for item in response.context["catalog_rows"]], [self.rack.pk])
        response = self.client.get(self.url, {"name": f"#{self.other.pk}", "device_count": 0})
        self.assertEqual([item["rack"].pk for item in response.context["catalog_rows"]], [self.other.pk])

    def test_favorites_open_the_selected_view_and_fall_back_when_scope_changes(self):
        key = f"global-{self.global_view.pk}"
        response = self.client.get(self.url, {"configure": self.rack.pk})
        self.assertIn((key, "Group technician (global)"), response.context["view_choices"])
        self.assertEqual(self.client.post(self.url, {"action": "save", "rack": self.other.pk, "view": key})
                         .status_code, 400)
        response = self.client.post(self.url, {"action": "save", "rack": self.rack.pk, "view": key}, follow=True)
        self.assertTrue(response.context["favorite_rows"][0]["url"].endswith(f"?view={key}"))
        self.assertTrue(response.context["catalog_rows"][0]["url"].endswith(f"?view={key}"))
        self.global_view.tags.clear()
        row = self.client.get(self.url).context["favorite_rows"][0]
        self.assertTrue(row["view_unavailable"])
        self.assertTrue(row["url"].endswith(f"?view={self.default.pk}"))
        response = self.client.post(self.url, {"action": "save", "rack": self.rack.pk, "view": "personal"}, follow=True)
        self.assertTrue(response.context["favorite_rows"][0]["url"].endswith("?view=personal"))

    def test_adding_filtered_matches_preserves_existing_choices(self):
        FavoriteRack.objects.create(user=self.user, rack=self.rack, view_key=str(self.local.pk))
        response = self.client.post(f"{self.url}?name=Rack", {"action": "add-matching"}, follow=True)
        self.assertEqual(len(response.context["favorite_rows"]), 2)
        self.assertEqual(FavoriteRack.objects.get(user=self.user, rack=self.rack).view_key, str(self.local.pk))
        self.assertEqual(FavoriteRack.objects.get(user=self.user, rack=self.other).view_key, "default")
        self.assertEqual(self.client.post(self.url, {"action": "add-matching"}).status_code, 400)

    def test_default_favorite_uses_the_applicable_global_default_after_local_override(self):
        self.global_view.is_default = True
        self.global_view.save(update_fields=["is_default"])
        FavoriteRack.objects.create(user=self.user, rack=self.rack, view_key="default")
        response = self.client.get(self.url, {"configure": self.rack.pk})
        key = f"global-{self.global_view.pk}"
        self.assertTrue(response.context["favorite_rows"][0]["url"].endswith(f"?view={self.default.pk}"))
        self.assertIn((key, "Group technician (global)"), response.context["view_choices"])

        self.default.delete()
        response = self.client.get(self.url, {"configure": self.rack.pk})
        self.assertTrue(response.context["favorite_rows"][0]["url"].endswith(f"?view={key}"))
        self.assertIn((key, "Group technician (rack default)"), response.context["view_choices"])

    def test_favorites_and_catalog_respect_user_and_object_permissions(self):
        FavoriteRack.objects.create(user=self.owner, rack=self.rack)
        FavoriteRack.objects.create(user=self.user, rack=self.other)
        self.remove_permissions("dcim.view_rack", "dcim.view_device")
        permission = ObjectPermission.objects.create(
            name="Rack A only", actions=["view"], constraints={"pk": self.rack.pk},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(Rack))
        permission.users.add(self.user)
        response = self.client.get(self.url)
        self.assertEqual(response.context["favorite_rows"], [])
        self.assertEqual([item["rack"].pk for item in response.context["catalog_rows"]], [self.rack.pk])
        self.assertEqual(response.context["catalog_rows"][0]["rack"].visible_device_count, 0)
        self.assertEqual(self.client.post(self.url, {"action": "save", "rack": self.other.pk, "view": "default"})
                         .status_code, 404)
        self.client.post(self.url, {"action": "remove", "rack": self.rack.pk})
        self.assertTrue(FavoriteRack.objects.filter(user=self.owner, rack=self.rack).exists())
