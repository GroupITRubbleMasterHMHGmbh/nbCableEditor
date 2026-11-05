from core.models import ObjectType
from dcim.choices import InterfaceTypeChoices
from dcim.models import DeviceType, InterfaceTemplate, Manufacturer, ModuleBayTemplate, ModuleType
from django.urls import reverse
from extras.models import ImageAttachment
from utilities.testing import TestCase

from nbcableeditor.models import LayoutRevision, PortPlacement
from nbcableeditor.views import layout_designs


class TypeDesignTestCase(TestCase):
    user_permissions = (
        "dcim.view_devicetype", "dcim.change_devicetype", "dcim.view_moduletype", "dcim.change_moduletype",
        "dcim.view_interfacetemplate", "dcim.view_modulebaytemplate", "extras.view_imageattachment",
    )

    @classmethod
    def setUpTestData(cls):
        manufacturer = Manufacturer.objects.create(name="Type Design", slug="type-design")
        cls.device_type = DeviceType.objects.create(manufacturer=manufacturer, model="Chassis", slug="chassis")
        cls.module_type = ModuleType.objects.create(manufacturer=manufacturer, model="Line card")
        cls.device_bay = ModuleBayTemplate.objects.create(device_type=cls.device_type, name="Card 1")
        cls.module_bay = ModuleBayTemplate.objects.create(module_type=cls.module_type, name="Submodule")
        cls.port = InterfaceTemplate.objects.create(
            module_type=cls.module_type, name="Ethernet{module}/1", type=InterfaceTypeChoices.TYPE_1GE_FIXED,
        )
        ImageAttachment.objects.create(
            object_type=ObjectType.objects.get_for_model(ModuleType), object_id=cls.module_type.pk,
            name="FRONT", image="image-attachments/module-front.png", image_width=100, image_height=50,
        )

    def route(self, name, owner):
        prefix = "module-" if isinstance(owner, ModuleType) else ""
        return reverse(f"plugins:nbcableeditor:{prefix}{name}", args=[owner.pk])

    def read(self, owner):
        return self.client.get(self.route("layout", owner)).context["layout_data"]

    def save(self, owner, revision, placements=(), **options):
        return self.client.post(
            self.route("placements", owner), {"revision": revision, "placements": placements, **options},
            content_type="application/json",
        )

    def bay(self, template, **options):
        return {
            "kind": "bay", "bay": template.pk, "x": .15, "y": .2, "width": .7, "height": .6, **options,
        }

    def test_module_design_labels_and_native_attachment_round_trip(self):
        data = self.read(self.module_type)
        self.assertEqual(data["layoutKind"], "module")
        self.assertEqual(data["bays"], [{"id": self.module_bay.pk, "name": "Submodule"}])
        self.assertTrue(data["frontImage"].endswith("/module-front.png"))
        self.assertIsNone(data["rearImage"])
        self.assertEqual([port["id"] for port in data["ports"]], [self.port.pk])

        label = {"port_id": self.port.pk, "face": "rear", "x": .8, "y": .4, "label": "U1"}
        title = {"kind": "text", "x": .5, "y": .1, "text": "{device.name}", "font": "monospace", "size": 16}
        design = {"front": {"useImage": False, "items": [title, self.bay(self.module_bay, moduleFace="rear")]}}
        saved = self.save(self.module_type, 0, [label], design=design)
        self.assertEqual(saved.status_code, 200, saved.content)
        self.assertEqual(saved.json(), {"revision": 1})
        self.assertEqual(self.read(self.module_type)["design"], design)
        self.assertEqual(self.read(self.module_type)["placements"], [label])
        self.assertEqual(self.read(self.device_type)["design"], {})
        self.assertEqual(PortPlacement.objects.get().label, "U1")
        self.assertEqual(layout_designs(self.user, [self.device_type.pk], [self.module_type.pk]), (
            {}, {self.module_type.pk: design},
        ))
        self.assertEqual(self.save(self.module_type, 1, [label]).status_code, 200)
        self.assertEqual(self.read(self.module_type)["design"], design)

    def test_invalid_design_and_foreign_bay_leave_revision_unchanged(self):
        bay = self.bay(self.device_bay, moduleFace="front")
        design = {"rear": {"useImage": True, "items": [bay]}}
        self.assertEqual(self.save(self.device_type, 0, design=design).status_code, 200)
        for items in (
            [bay, bay],
            [self.bay(self.module_bay)],
            [self.bay(self.device_bay, x=1, width=1e-12)],
            [self.bay(self.device_bay, moduleFace="both")],
            [self.bay(self.device_bay, color="url(bad)")],
        ):
            with self.subTest(items=items):
                response = self.save(self.device_type, 1, design={"rear": {"useImage": False, "items": items}})
                self.assertEqual(response.status_code, 400, response.content)
        layout = LayoutRevision.objects.get(device_type=self.device_type)
        self.assertEqual((layout.revision, layout.design), (1, design))

    def test_rectangle_frame_and_label_round_trip_with_legacy_rectangles(self):
        rectangle = {"kind": "rectangle", "x": .1, "y": .2, "width": .7, "height": .5}
        label = {"text": "{device.name}", "font": "serif", "size": 24, "position": "left", "color": "#aabbcc"}
        frame = {**rectangle, "borderColor": "#123abc", "label": label}
        filled = {**frame, "color": "#abcdef", "label": {**label, "position": "center"}}
        corner_positions = ("top-left", "top-right", "bottom-left", "bottom-right")
        corners = [{**frame, "label": {**label, "position": position}} for position in corner_positions]
        design = {"front": {"useImage": True, "items": [rectangle, frame, filled, *corners]}}
        response = self.save(self.device_type, 0, design=design)
        self.assertEqual(response.status_code, 200, response.content)

        stored_label = {**label, "color": "#AABBCC"}
        stored_frame = {**frame, "borderColor": "#123ABC", "label": stored_label}
        stored_fill = {**stored_frame, "color": "#ABCDEF", "label": {**stored_label, "position": "center"}}
        stored_corners = [
            {**stored_frame, "label": {**stored_label, "position": position}} for position in corner_positions
        ]
        self.assertEqual(
            self.read(self.device_type)["design"]["front"]["items"], [rectangle, stored_frame, stored_fill, *stored_corners],
        )

        for invalid in (
            {**frame, "borderColor": "transparent"},
            {**frame, "label": {**label, "position": "outside"}},
            {**frame, "label": {**label, "size": 100}},
            {**frame, "label": {**label, "font": "unknown"}},
        ):
            with self.subTest(invalid=invalid):
                design["front"]["items"] = [invalid]
                response = self.save(self.device_type, 1, design=design)
                self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(self.read(self.device_type)["revision"], 1)

    def test_layout_read_and_save_preserve_hidden_bay(self):
        bay = self.bay(self.device_bay, moduleFace="front")
        design = {"front": {"useImage": True, "items": [bay]}}
        self.assertEqual(self.save(self.device_type, 0, design=design).status_code, 200)
        self.remove_permissions("dcim.view_modulebaytemplate")
        hidden_design = {"front": {"useImage": False, "items": []}}
        self.assertEqual(self.read(self.device_type)["bays"], [])
        self.assertEqual(self.read(self.device_type)["design"]["front"]["items"], [])
        self.assertEqual(self.save(self.device_type, 1, design=hidden_design).status_code, 200)
        self.assertEqual(LayoutRevision.objects.get(device_type=self.device_type).design, {
            "front": {"useImage": False, "items": [bay]},
        })
