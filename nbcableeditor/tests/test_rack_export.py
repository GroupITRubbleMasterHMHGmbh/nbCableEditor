from core.models import ObjectType
from dcim.models import Location, Rack, Site
from django.urls import reverse
from users.models import ObjectPermission
from utilities.testing import TestCase


class RackExportTest(TestCase):
    user_permissions = ("dcim.view_rack",)

    @classmethod
    def setUpTestData(cls):
        site = Site.objects.create(name="Export site", slug="export-site")
        cls.location = Location.objects.create(site=site, name="Private room", slug="private-room")
        cls.rack = Rack.objects.create(site=site, location=cls.location, name="Export rack")

    def test_rack_export_projects_location_only_when_readable(self):
        url = reverse("plugins:nbcableeditor:rack", args=[self.rack.pk])
        data = self.client.get(url).context["rack_data"]
        self.assertEqual(data["rackId"], self.rack.pk)
        self.assertEqual(data["rackUrl"], self.rack.get_absolute_url())
        self.assertEqual(data["editorUrl"], url)
        self.assertIsNone(data["rackLocation"])

        permission = ObjectPermission.objects.create(name="Export location", actions=["view"], constraints={"pk": 0})
        permission.object_types.add(ObjectType.objects.get_for_model(Location))
        permission.users.add(self.user)
        self.assertIsNone(self.client.get(url).context["rack_data"]["rackLocation"])

        permission.constraints = {"pk": self.location.pk}
        permission.save()
        self.assertEqual(self.client.get(url).context["rack_data"]["rackLocation"], self.location.name)
