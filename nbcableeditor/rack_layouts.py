"""Project saved type layouts onto the equipment installed in a rack."""

from collections import defaultdict

from dcim.models import Module, ModuleBay, ModuleBayTemplate, ModuleType
from dcim.utils import get_module_bay_positions, resolve_module_placeholder
from django.db.models import Q

from .layout_placeholders import RackPlaceholderValues
from .models import PortPlacement


def _resolved_name(name, positions):
    try:
        return resolve_module_placeholder(name, positions) if positions else name
    except ValueError:
        # An out-of-date template may no longer match this module's depth.
        return name


def rack_layouts(user, devices, visible_types, port_types, load_designs, load_module_images):
    device_ids = {device.pk for device in devices}
    type_ids = {device.device_type_id for device in devices}
    bays = {
        (bay.device_id, bay.module_id, bay.name): bay
        for bay in ModuleBay.objects.restrict(user).filter(device_id__in=device_ids)
    }
    modules = list(Module.objects.restrict(user).filter(device_id__in=device_ids).select_related(
        "module_type", "module_bay",
    ))
    visible_module_types = set(ModuleType.objects.restrict(user).filter(
        pk__in={module.module_type_id for module in modules},
    ).values_list("pk", flat=True))
    modules_by_bay = {module.module_bay_id: module for module in modules if module.module_type_id in visible_module_types}
    device_designs, module_designs = load_designs(user, visible_types, visible_module_types)
    placeholders = RackPlaceholderValues(user, (*device_designs.values(), *module_designs.values()), {
        "device": {device.pk: device for device in devices},
        "device.type": {device.device_type_id: device.device_type for device in devices if device.device_type_id in visible_types},
        "module": {module.pk: module for module in modules_by_bay.values()},
        "module.type": {module.module_type_id: module.module_type for module in modules_by_bay.values()},
    })
    module_images = load_module_images(user, visible_module_types)
    bay_templates = {
        template.pk: template for template in ModuleBayTemplate.objects.restrict(user).filter(
            pk__in={
                item["bay"]
                for design in (*device_designs.values(), *module_designs.values())
                for side in design.values()
                for item in side.get("items", [])
                if item["kind"] == "bay"
            },
        )
    }

    device_ports = {}
    module_templates = defaultdict(list)
    for kind, (_, field, _) in port_types.items():
        relation = field.removesuffix("_id")
        placements = PortPlacement.objects.filter(
            _owner_filter(relation, type_ids, visible_module_types)
        ).select_related(relation)
        for placement in placements:
            template = getattr(placement, relation)
            if template.device_type_id is not None:
                device_ports[kind, template.device_type_id, template.name] = _port_point(placement)
            elif template.module_type_id in visible_module_types:
                module_templates[template.module_type_id, placement.face].append((kind, template.name, placement))

    positions = {}
    module_ports = {}
    artwork = {}
    for device in devices:
        device_subjects = {"device": device.pk, "device.type": device.device_type_id}

        def project(layout, side, face, bounds, module=None, ancestors=()):
            x, y, width, height = bounds
            design = layout.get(side, {})
            subjects = device_subjects
            if module:
                subjects = {**device_subjects, "module": module.pk, "module.type": module.module_type_id}
                if module.pk not in positions:
                    positions[module.pk] = get_module_bay_positions(module.module_bay)
                for kind, name, placement in module_templates[module.module_type_id, side]:
                    name = _resolved_name(name, positions[module.pk])
                    module_ports.setdefault((module.pk, kind, name), {
                        **_port_point(placement), "face": face,
                        "x": x + placement.x * width, "y": y + placement.y * height,
                    })

            items = []
            for item in design.get("items", []):
                element = dict(item)
                if item["kind"] == "text":
                    element["text"] = placeholders.render(item["text"], subjects)
                elif item["kind"] == "rectangle" and (label := item.get("label")):
                    element["label"] = {**label, "text": placeholders.render(label["text"], subjects)}
                elif item["kind"] == "bay":
                    template = bay_templates.get(item["bay"])
                    if not template:
                        continue
                    name = _resolved_name(template.name, positions[module.pk] if module else ())
                    bay = bays.get((device.pk, module.pk if module else None, name))
                    if not bay:
                        continue
                    element["name"] = bay.name
                    installed = modules_by_bay.get(bay.pk)
                    if installed and installed.pk not in ancestors:
                        next_side = item.get("moduleFace", "front")
                        element["module"] = project(
                            module_designs.get(installed.module_type_id, {}), next_side, face,
                            (x + item["x"] * width, y + item["y"] * height,
                             item["width"] * width, item["height"] * height),
                            installed, (*ancestors, installed.pk),
                        )
                        element["module"]["name"] = str(installed.module_type)
                        element["module"]["image"] = module_images.get(installed.module_type_id, {}).get(next_side + "Image")
                items.append(element)
            return {"useImage": design.get("useImage", True), "items": items}

        layout = device_designs.get(device.device_type_id)
        if layout:
            sides = ("front", "rear") if device.device_type.is_full_depth else ("front",)
            artwork[device.pk] = {
                face: project(layout, face, face, (0, 0, 1, 1)) for face in sides
            }
    return device_ports, module_ports, artwork


def _owner_filter(relation, device_types, module_types):
    return Q(**{f"{relation}__device_type_id__in": device_types}) | Q(
        **{f"{relation}__module_type_id__in": module_types},
    )


def _port_point(placement):
    return {"face": placement.face, "x": placement.x, "y": placement.y, "layoutLabel": placement.label}
