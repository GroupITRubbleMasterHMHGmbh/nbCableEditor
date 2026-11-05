"""Run through manage.py shell in the local development instance."""
from io import BytesIO

from dcim.choices import CableTypeChoices, InterfaceModeChoices, InterfaceTypeChoices, PortTypeChoices
from dcim.models import (
    Cable, Device, DeviceRole, DeviceType, FrontPortTemplate, InterfaceTemplate, Location,
    Manufacturer, PortMapping, PortTemplateMapping, Rack, RearPortTemplate, Site,
)
from django.core.files.base import ContentFile
from django.db import transaction
from ipam.models import VLAN, VLANGroup
from PIL import Image, ImageDraw, ImageFont

from nbcableeditor.cable_views import port_unavailable
from nbcableeditor.models import PortPlacement

from dev.module_demo import seed_module_demo


def png(image):
    result = BytesIO()
    image.save(result, format="PNG")
    return ContentFile(result.getvalue())


def image_for_face(front):
    image = Image.new("RGB", (1200, 108), "#202d3d")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((3, 3, 1196, 104), radius=10, fill="#253245", outline="#60778b", width=3)
    if front:
        draw.text((25, 31), "DEMO SWITCH", fill="#d8e4ee")
        for row in range(2):
            for column in range(24):
                x, y = 150 + 40 * column, 21 + 42 * row
                draw.rounded_rectangle((x, y, x + 30, y + 26), radius=3, fill="#101923", outline="#677e93")
        draw.ellipse((1149, 37, 1159, 47), fill="#66dc8e")
    else:
        for index in range(4):
            x = 410 + index * 120
            draw.rounded_rectangle((x, 26, x + 66, 83), radius=5, fill="#111b28", outline="#7e92a6")
            for slit in range(5):
                draw.line((x + 10, 37 + slit * 8, x + 55, 37 + slit * 8), fill="#52657b", width=2)
        draw.rounded_rectangle((960, 27, 1140, 81), radius=7, fill="#172332", outline="#6c8497")
    return png(image)


def panel_jack_x(number):
    return 450 + 122 * (number - 1)


def panel_image(front):
    image = Image.new("RGB", (1200, 108), "#202d3d")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((3, 3, 1196, 104), radius=10, fill="#28384a", outline="#60778b", width=3)
    font = ImageFont.load_default(size=24)
    draw.text((250, 54), "PP-01  /  " + ("FRONT" if front else "REAR"),
              anchor="mm", fill="#d8e4ee", font=font)
    for number in range(1, 7):
        x = panel_jack_x(number)
        draw.rounded_rectangle((x - 34, 19, x + 34, 61), radius=5,
                               fill="#101923", outline="#93a6b8", width=2)
        draw.rectangle((x - 20, 30, x + 20, 53), fill="#657687" if front else "#ad8551")
        draw.text((x, 82), f"{number:02}", anchor="mm", fill="#d8e4ee", font=font)
    return png(image)


def passive_type(manufacturer, slug, model, jack_names, *, mounted=False):
    device_type, _ = DeviceType.objects.get_or_create(
        manufacturer=manufacturer, slug=slug,
        defaults={"model": model, "u_height": int(mounted), "is_full_depth": mounted},
    )
    for name in jack_names:
        front, _ = FrontPortTemplate.objects.get_or_create(
            device_type=device_type, name=f"{name} Front", defaults={"type": PortTypeChoices.TYPE_8P8C},
        )
        rear, _ = RearPortTemplate.objects.get_or_create(
            device_type=device_type, name=f"{name} Rear", defaults={"type": PortTypeChoices.TYPE_8P8C},
        )
        PortTemplateMapping.objects.get_or_create(
            device_type=device_type, front_port=front, front_port_position=1,
            defaults={"rear_port": rear, "rear_port_position": 1},
        )
    return device_type


def connect_demo(a, b, *, label, color):
    if a.cable_id or b.cable_id:
        if a.cable_id != b.cable_id:
            print(f"Skipped {label}: an endpoint already has a cable.")
        return False
    if any(getattr(port, "mark_connected", False) for port in (a, b)):
        print(f"Skipped {label}: an endpoint is marked connected.")
        return False
    cable = Cable(
        a_terminations=[a], b_terminations=[b], type=CableTypeChoices.TYPE_CAT6A, label=label, color=color,
    )
    cable.full_clean()
    cable.save()
    return True


def set_demo_vlan(interface, untagged, tagged=None):
    if interface.mode or interface.untagged_vlan_id or interface.tagged_vlans.exists():
        return
    interface.mode = InterfaceModeChoices.MODE_TAGGED if tagged else InterfaceModeChoices.MODE_ACCESS
    interface.untagged_vlan = untagged
    interface.full_clean()
    interface.save(update_fields=("mode", "untagged_vlan"))
    if tagged:
        interface.tagged_vlans.add(tagged)


def legacy_demo_device(site, device_type, name):
    if not name:
        return None
    return Device.objects.filter(site=site, device_type=device_type, name=name).first()


def demo_endpoint(site, office, device_type, role, name, legacy_name=None):
    # Keep earlier demo devices, cables, and user edits when the seed is run again.
    device = legacy_demo_device(site, device_type, legacy_name)
    if device is None:
        device, _ = Device.objects.get_or_create(
            site=site, name=name,
            defaults={"location": office, "device_type": device_type, "role": role},
        )
    return device


def seed_patch_demo(rack, switch, manufacturer):
    site = rack.site
    panel_type = passive_type(
        manufacturer, "demo-patch-panel-4", "Demo Patch Panel 6", [f"P{n:02}" for n in range(1, 7)],
        mounted=True,
    )
    type_changed = panel_type.model == "Demo Patch Panel 4"
    if type_changed:
        panel_type.model = "Demo Patch Panel 6"
    for side in ("front", "rear"):
        image = getattr(panel_type, f"{side}_image")
        if not image or image.name.endswith(f"/demo-patch-panel-4-{side}.png"):
            image.save(f"demo-patch-panel-6-{side}.png", panel_image(side == "front"), save=False)
            type_changed = True
    if type_changed:
        panel_type.save()

    outlet_type = passive_type(manufacturer, "demo-wall-outlet", "Demo RJ45 Wall Outlet", ["RJ45"])
    passive_role, _ = DeviceRole.objects.get_or_create(
        slug="nbcableeditor-demo-passive", defaults={"name": "Demo Passive Cabling", "color": "66788a"},
    )
    client_role, _ = DeviceRole.objects.get_or_create(
        slug="nbcableeditor-demo-client", defaults={"name": "Demo Endpoint", "color": "168577"},
    )
    office, _ = Location.objects.get_or_create(site=site, slug="nbcableeditor-demo-office",
                                               defaults={"name": "Demo Office"})

    panel_name = "Patch Panel PP-01"
    panel = legacy_demo_device(site, panel_type, "Patchpanel PP-01")
    if panel is None:
        panel = Device.objects.filter(site=site, name=panel_name).first()
    if panel is None:
        available = rack.get_available_units()
        position = 8 if 8 in available else next(iter(available), None)
        if position is None:
            print("Skipped patch panel demo: no free rack unit.")
            return
        panel = Device.objects.create(
            site=site, rack=rack, position=position, face="front", device_type=panel_type,
            role=passive_role, name=panel_name,
        )
    if panel.rack_id != rack.pk or panel.device_type_id != panel_type.pk:
        print(f"Skipped patch panel demo: {panel.name} is already used by another setup.")
        return

    for number in range(1, 7):
        front_name, rear_name = f"P{number:02} Front", f"P{number:02} Rear"
        front_template = panel_type.frontporttemplates.get(name=front_name)
        rear_template = panel_type.rearporttemplates.get(name=rear_name)
        front, _ = panel.frontports.get_or_create(name=front_name, defaults={"type": front_template.type})
        rear, _ = panel.rearports.get_or_create(name=rear_name, defaults={"type": rear_template.type})
        PortMapping.objects.get_or_create(
            device=panel, front_port=front, front_port_position=1,
            defaults={"rear_port": rear, "rear_port_position": 1},
        )
        x = panel_jack_x(number) / 1200
        PortPlacement.objects.get_or_create(
            front_port_template=front_template, defaults={"face": PortPlacement.Face.FRONT, "x": x, "y": 40 / 108},
        )
        PortPlacement.objects.get_or_create(
            rear_port_template=rear_template, defaults={"face": PortPlacement.Face.REAR, "x": x, "y": 40 / 108},
        )

    vlan_group, _ = VLANGroup.objects.get_or_create(
        slug="nbcableeditor-demo", defaults={"name": "Cable Editor Demo"},
    )
    clients, _ = VLAN.objects.get_or_create(group=vlan_group, vid=50, defaults={"name": "Lab Clients"})
    management, _ = VLAN.objects.get_or_create(group=vlan_group, vid=99, defaults={"name": "Lab Management"})

    lanes = (
        (36, "Workstation PC-01", "Arbeitsplatz PC-01", "demo-workstation", "Demo Workstation", "2563eb"),
        (38, "Printer PR-01", "Drucker PR-01", "demo-printer", "Demo Printer", "198754"),
        (42, "Access Point AP-01", None, "demo-access-point", "Demo Access Point", "a855f7"),
        (46, None, None, None, None, "e6ad23"),
    )
    for number, (switch_port, client_name, legacy_client, client_slug, client_model, color) in enumerate(lanes, start=1):
        panel_jack = f"P{number:02}"
        outlet_name = f"Wall Outlet WD-{number:02}"
        outlet = demo_endpoint(
            site, office, outlet_type, passive_role, outlet_name, f"Wanddose WD-{number:02}",
        )
        if outlet.device_type_id != outlet_type.pk:
            print(f"Skipped {outlet_name}: the name is already used by another device.")
            continue

        uplink = switch.interfaces.get(name=f"Ethernet{switch_port}")
        panel_front = panel.frontports.get(name=f"{panel_jack} Front")
        panel_rear = panel.rearports.get(name=f"{panel_jack} Rear")
        outlet_front = outlet.frontports.get(name="RJ45 Front")
        outlet_rear = outlet.rearports.get(name="RJ45 Rear")
        tagged = clients if number == 3 else None
        untagged = management if tagged else clients
        if uplink.enabled and not port_unavailable(uplink):
            if connect_demo(uplink, panel_front, label=f"Demo Patch {panel_jack}", color=color):
                set_demo_vlan(uplink, untagged, tagged)
        else:
            print(f"Skipped Demo Patch {panel_jack}: {uplink.name} is unavailable.")
        connect_demo(panel_rear, outlet_rear, label=f"Demo Permanent Link WD-{number:02}", color="808995")

        if client_name:
            client_type, _ = DeviceType.objects.get_or_create(
                manufacturer=manufacturer, slug=client_slug, defaults={"model": client_model, "u_height": 0},
            )
            InterfaceTemplate.objects.get_or_create(
                device_type=client_type, name="Ethernet1", defaults={"type": InterfaceTypeChoices.TYPE_1GE_FIXED},
            )
            client = demo_endpoint(site, office, client_type, client_role, client_name, legacy_client)
            if client.device_type_id != client_type.pk:
                print(f"Skipped {client_name}: the name is already used by another device.")
                continue
            nic = client.interfaces.get(name="Ethernet1")
            if nic.enabled and not port_unavailable(nic):
                if connect_demo(outlet_front, nic, label=f"Demo Endpoint Patch WD-{number:02}", color=color):
                    set_demo_vlan(nic, untagged, tagged)

    spare = switch.interfaces.get(name="Ethernet48")
    if spare.enabled and not spare.cable_id and not port_unavailable(spare):
        set_demo_vlan(spare, clients)
    print(f"Patch demo: {rack.get_absolute_url()} · Switch A #{switch.pk} · {panel.name} #{panel.pk}")


with transaction.atomic():
    site, _ = Site.objects.get_or_create(slug="nbcableeditor-demo", defaults={"name": "Cable Editor Demo"})
    rack, _ = Rack.objects.get_or_create(site=site, name="Lab Rack 01", defaults={"u_height": 12})
    manufacturer, _ = Manufacturer.objects.get_or_create(
        slug="nbcableeditor-demo", defaults={"name": "Cable Editor Demo"}
    )
    device_type, _ = DeviceType.objects.get_or_create(
        manufacturer=manufacturer, slug="switch-48",
        defaults={"model": "Demo Switch 48", "is_full_depth": True},
    )
    if not device_type.front_image:
        device_type.front_image.save("demo-switch-48-front.png", image_for_face(True), save=False)
    if not device_type.rear_image:
        device_type.rear_image.save("demo-switch-48-rear.png", image_for_face(False), save=False)
    device_type.save()
    for number in range(1, 49):
        template, _ = InterfaceTemplate.objects.get_or_create(
            device_type=device_type, name=f"Ethernet{number}",
            defaults={"type": InterfaceTypeChoices.TYPE_1GE_FIXED},
        )
        row, column = divmod(number - 1, 24)
        PortPlacement.objects.get_or_create(
            interface_template=template,
            defaults={"face": PortPlacement.Face.FRONT, "x": (165 + 40 * column) / 1200, "y": (34 + 42 * row) / 108},
        )
    role, _ = DeviceRole.objects.get_or_create(
        slug="nbcableeditor-demo", defaults={"name": "Demo Switch", "color": "4a81b8"}
    )
    switches = {}
    for name, position in (("Switch A", 9), ("Switch B", 6)):
        switches[name], _ = Device.objects.get_or_create(
            site=site, name=name,
            defaults={"rack": rack, "position": position, "face": "front", "role": role, "device_type": device_type},
        )
    if switches["Switch A"].rack_id == rack.pk and switches["Switch A"].device_type_id == device_type.pk:
        seed_patch_demo(rack, switches["Switch A"], manufacturer)
    seed_module_demo(rack)

print(f"Rack: {rack.get_absolute_url()} — Device type: {device_type.get_absolute_url()}")
