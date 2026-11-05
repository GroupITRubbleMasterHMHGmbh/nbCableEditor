from dcim.choices import InterfaceTypeChoices
from dcim.models import (
    Device, DeviceRole, DeviceType, InterfaceTemplate, Manufacturer, Module, ModuleBay,
    ModuleBayTemplate, ModuleType, Rack, Site,
)
from django.urls import reverse
from utilities.testing import TestCase

from nbcableeditor.calculator import RackCalculator, UNIT_MM, normalize_profile
from nbcableeditor.models import LayoutRevision, PortPlacement


class RackModuleLayoutTestCase(TestCase):
    user_permissions = (
        "dcim.view_rack", "dcim.view_device", "dcim.view_devicetype", "dcim.view_interface",
        "dcim.view_module", "dcim.view_moduletype", "dcim.view_modulebay", "dcim.view_modulebaytemplate",
    )

    def test_nested_module_projects_the_installed_ports_and_device_labels(self):
        site = Site.objects.create(name="Module lab", slug="module-lab")
        rack = Rack.objects.create(site=site, name="Chassis rack")
        manufacturer = Manufacturer.objects.create(name="Module layout", slug="module-layout")
        role = DeviceRole.objects.create(name="Chassis", slug="chassis")
        chassis_type = DeviceType.objects.create(manufacturer=manufacturer, model="Chassis", slug="chassis")
        card_type = ModuleType.objects.create(manufacturer=manufacturer, model="Card")
        subcard_type = ModuleType.objects.create(manufacturer=manufacturer, model="Subcard")
        card_bay = ModuleBayTemplate.objects.create(device_type=chassis_type, name="Slot 3", position="3")
        subcard_bay = ModuleBayTemplate.objects.create(module_type=card_type, name="Slot {module}/2", position="2")
        port_template = InterfaceTemplate.objects.create(
            module_type=subcard_type, name="Ethernet{module}/{module}/1", type=InterfaceTypeChoices.TYPE_1GE_FIXED,
        )
        device = Device.objects.create(
            device_type=chassis_type, role=role, site=site, rack=rack, name="Test chassis", position=1, face="front",
        )
        card = Module.objects.create(device=device, module_type=card_type, module_bay=ModuleBay.objects.get(device=device))
        Module.objects.create(device=device, module_type=subcard_type, module_bay=ModuleBay.objects.get(module=card))

        LayoutRevision.objects.create(device_type=chassis_type, design={
            "front": {"useImage": False, "items": [
                {"kind": "bay", "bay": card_bay.pk, "moduleFace": "rear", "x": .25, "y": .25, "width": .5, "height": .5},
            ]},
        })
        LayoutRevision.objects.create(module_type=card_type, design={
            "rear": {"useImage": True, "items": [
                {"kind": "bay", "bay": subcard_bay.pk, "x": .25, "y": .25, "width": .5, "height": .5},
            ]},
        })
        LayoutRevision.objects.create(module_type=subcard_type, design={
            "front": {"useImage": False, "items": [
                {"kind": "text", "x": .5, "y": .1, "text": "{device.name} · {module.type} · {module.bay}",
                 "font": "monospace", "size": 16},
                {"kind": "rectangle", "x": .1, "y": .2, "width": .8, "height": .7, "borderColor": "#ABCD12",
                 "label": {"text": "{device.name} · {module.bay}", "font": "serif", "size": 22, "position": "right"}},
            ]},
        })
        PortPlacement.objects.create(interface_template=port_template, face="front", x=.75, y=.5, label="Uplink")

        url = reverse("plugins:nbcableeditor:rack", args=[rack.pk])
        rack_data = self.client.get(url).context["rack_data"]
        payload = rack_data["devices"][0]
        port, = payload["ports"]
        self.assertEqual((port["name"], port["face"], port["x"], port["y"], port["layoutLabel"]),
                         ("Ethernet3/2/1", "front", .5625, .5, "Uplink"))
        _, point, warning = RackCalculator(rack, rack_data, normalize_profile({}), {}).endpoint(port["id"], None)
        self.assertIsNone(warning)
        self.assertAlmostEqual(point.x[0], .5625 * 19 * 25.4)
        self.assertAlmostEqual(point.y[0], (rack.u_height - .5) * UNIT_MM)
        drawing = payload["design"]["front"]
        self.assertFalse(drawing["useImage"])
        card_drawing = drawing["items"][0]["module"]
        self.assertEqual(card_drawing["name"], "Card")
        subcard_items = card_drawing["items"][0]["module"]["items"]
        self.assertEqual(subcard_items[0]["text"], "Test chassis · Subcard · Slot 3/2")
        self.assertEqual(subcard_items[1]["borderColor"], "#ABCD12")
        self.assertNotIn("color", subcard_items[1])
        self.assertEqual(subcard_items[1]["label"], {
            "text": "Test chassis · Slot 3/2", "font": "serif", "size": 22, "position": "right",
        })

        self.remove_permissions("dcim.view_module")
        payload = self.client.get(url).context["rack_data"]["devices"][0]
        self.assertIsNone(payload["ports"][0]["x"])
        self.assertNotIn("module", payload["design"]["front"]["items"][0])
