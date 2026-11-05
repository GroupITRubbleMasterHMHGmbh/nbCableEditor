"""Seed the modular chassis in the local rack demo."""

from dcim.choices import CableTypeChoices, InterfaceTypeChoices
from dcim.models import (
    Cable, Device, DeviceRole, DeviceType, InterfaceTemplate, Manufacturer, Module, ModuleBay, ModuleBayTemplate,
    ModuleType,
)
from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from extras.models import ImageAttachment

from nbcableeditor.models import LayoutRevision, PortPlacement

from dev.module_demo_art import (
    BAY_BOXES, CHASSIS_SIZE, MODULE_PORT_CENTERS, MODULE_SIZE, chassis_artwork, module_artwork,
)


CHASSIS_NAME = "Modular Chassis MC-01"
FACES = ("front", "rear")


def _module_type(manufacturer, model, title, accent):
    module_type, _ = ModuleType.objects.get_or_create(manufacturer=manufacturer, model=model)
    content_type = ContentType.objects.get_for_model(ModuleType)
    width, height = MODULE_SIZE
    for side, face in enumerate(FACES):
        attachments = ImageAttachment.objects.filter(
            object_type=content_type, object_id=module_type.pk, name__iexact=face,
        ).exclude(image="")
        if not attachments.exists():
            attachment = ImageAttachment(object_type=content_type, object_id=module_type.pk, name=face.title())
            filename = f"{title.lower().replace(' ', '-')}-{face}.png"
            attachment.image.save(filename, module_artwork(face, title=title, accent=accent), save=False)
            attachment.image_width, attachment.image_height = MODULE_SIZE
            attachment.save()

        for index, (x, y) in enumerate(MODULE_PORT_CENTERS, start=1):
            number = side * len(MODULE_PORT_CENTERS) + index
            template, _ = InterfaceTemplate.objects.get_or_create(
                module_type=module_type, name=f"Ethernet{{module}}/{number}",
                defaults={"type": InterfaceTypeChoices.TYPE_1GE_FIXED},
            )
            PortPlacement.objects.get_or_create(
                interface_template=template,
                defaults={"face": face, "x": x / width, "y": y / height, "label": str(number)},
            )
    return module_type


@transaction.atomic
def seed_module_demo(rack):
    existing = Device.objects.filter(site=rack.site, name=CHASSIS_NAME).first()
    available = rack.get_available_units(u_height=2) if existing is None else []
    if existing is None and not available:
        print(f"Skipped {CHASSIS_NAME}: {rack.name} has no two contiguous free rack units.")
        return

    manufacturer, _ = Manufacturer.objects.get_or_create(
        slug="nbcableeditor-demo", defaults={"name": "Cable Editor Demo"},
    )
    chassis_type, _ = DeviceType.objects.get_or_create(
        manufacturer=manufacturer, slug="demo-modular-chassis",
        defaults={"model": "Demo Modular Chassis 2U", "u_height": 2, "is_full_depth": True},
    )
    if existing and (
        existing.rack_id != rack.pk or existing.device_type_id != chassis_type.pk or existing.position is None
    ):
        print(f"Skipped {CHASSIS_NAME}: that name is already used by another setup.")
        return
    if chassis_type.u_height != 2 or not chassis_type.is_full_depth:
        print(f"Skipped {CHASSIS_NAME}: the demo requires a full-depth 2U device type.")
        return

    for face in FACES:
        image = getattr(chassis_type, f"{face}_image")
        if not image:
            image.save(f"demo-modular-chassis-{face}.png", chassis_artwork(face))

    bays = [
        ModuleBayTemplate.objects.get_or_create(
            device_type=chassis_type, name=f"Bay {number}", defaults={"position": str(number)},
        )[0]
        for number in range(1, len(BAY_BOXES) + 1)
    ]
    width, height = CHASSIS_SIZE
    LayoutRevision.objects.get_or_create(
        device_type=chassis_type,
        defaults={"design": {
            face: {"useImage": True, "items": [
                {"kind": "bay", "bay": template.pk, "moduleFace": face,
                 "x": x / width, "y": y / height, "width": w / width, "height": h / height}
                for template, (x, y, w, h) in zip(bays, BAY_BOXES, strict=True)
            ]}
            for face in FACES
        }},
    )

    chassis = existing
    if chassis is None:
        role, _ = DeviceRole.objects.get_or_create(
            slug="nbcableeditor-demo-modular", defaults={"name": "Demo Modular Chassis", "color": "6357a0"},
        )
        chassis = Device(
            site=rack.site, rack=rack, position=3 if 3 in available else available[0], face="front",
            device_type=chassis_type, role=role, name=CHASSIS_NAME,
        )
        chassis.full_clean()
        chassis.save()

    modules = (
        ("Demo Copper I/O 8", "COPPER I/O", "#176b79"),
        ("Demo Management I/O 8", "MANAGEMENT I/O", "#6c4880"),
    )
    installed_bays = [
        ModuleBay.objects.get_or_create(
            device=chassis, module=None, name=template.name, defaults={"position": template.position},
        )[0]
        for template in bays
    ]
    # Leave the last bay empty for testing.
    for bay, (model, title, accent) in zip(installed_bays, modules):
        if Module.objects.filter(module_bay=bay).exists():
            continue
        Module.objects.create(
            device=chassis, module_bay=bay, module_type=_module_type(manufacturer, model, title, accent),
        )

    if existing is None:
        cable = Cable(
            a_terminations=[chassis.interfaces.get(name="Ethernet1/4")],
            b_terminations=[chassis.interfaces.get(name="Ethernet2/1")],
            type=CableTypeChoices.TYPE_CAT6A, color="2563eb", label="Demo Module Link",
        )
        cable.full_clean()
        cable.save()
    print(f"Module demo: {chassis.name} in {rack.name} at U{chassis.position:g} · {chassis.get_absolute_url()}")
