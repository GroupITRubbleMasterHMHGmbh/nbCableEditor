import json
import re
from collections import defaultdict
from urllib.parse import urlencode

from core.models import ObjectType
from dcim.constants import NONCONNECTABLE_IFACE_TYPES
from dcim.models import (
    Cable, Device, DeviceType, FrontPort, FrontPortTemplate, Interface, InterfaceTemplate,
    ModuleBayTemplate, ModuleType, Rack, RearPort, RearPortTemplate,
)
from django.db import IntegrityError, transaction
from django.db.models import Exists, OuterRef, Prefetch, Q, prefetch_related_objects
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, render
from django.urls import reverse
from django.utils.translation import override
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_GET, require_POST
from extras.models import Bookmark, ImageAttachment, JournalEntry, Subscription
from ipam.models import VLAN

from . import NbCableEditorConfig
from .cable_history import history_for_rack
from .cable_views import cable_details, is_simple_cable, port_key, port_unavailable
from .configuration import ZOOM_CHOICES, cable_custom_values, can_manage_editor_settings, nbcableeditor_options
from .layout_catalog import templates_for
from .layout_placeholders import layout_placeholder_fields
from .metadata_tags import available_tags, tag_data
from .models import LayoutRevision, PortPlacement
from .rack_layouts import rack_layouts
from .rack_traces import PORT_KINDS, endpoint_data, native_path, port_metadata, readable_nodes, trace_payload


MAX_LAYOUT_BYTES = 512 * 1024
MAX_DESIGN_ITEMS_PER_FACE = 256
LAYOUT_FACES = ("front", "rear")
LAYOUT_TYPES = {
    "device": (DeviceType, "device_type", "Device type", "placements"),
    "module": (ModuleType, "module_type", "Module type", "module-placements"),
}
LAYOUT_FONTS = ("sans-serif", "serif", "monospace")
LAYOUT_LABEL_POSITIONS = (
    "top-left", "top", "top-right", "bottom-left", "bottom", "bottom-right", "left", "right", "center",
)
LAYOUT_PORTS = {
    "interface": (InterfaceTemplate, "interface_template_id", None),
    "front-port": (FrontPortTemplate, "front_port_template_id", "front"),
    "rear-port": (RearPortTemplate, "rear_port_template_id", "rear"),
}
CABLE_COLOR_PALETTE = (
    ("White", "#FFFFFF"),
    ("Beige", "#E7D3AB"),
    ("Gray", "#9CA3AF"),
    ("Dark gray", "#4B5563"),
    ("Black", "#000000"),
    ("Light blue", "#7DD3FC"),
    ("Blue", "#2563EB"),
    ("Dark blue", "#1E3A8A"),
    ("Light green", "#86EFAC"),
    ("Green", "#16A34A"),
    ("Dark green", "#14532D"),
    ("Pink", "#F472B6"),
    ("Yellow", "#FACC15"),
    ("Orange", "#EA580C"),
    ("Red", "#DC2626"),
    ("Violet", "#7C3AED"),
    ("Brown", "#92400E"),
)


def _route(name, pk):
    return reverse(f"plugins:nbcableeditor:{name}", args=[pk])


def _module_images(user, module_type_ids):
    images = {pk: {"frontImage": None, "rearImage": None} for pk in module_type_ids}
    attachments = ImageAttachment.objects.restrict(user).filter(
        object_type__app_label="dcim", object_type__model="moduletype", object_id__in=images,
    ).filter(Q(name__iexact="front") | Q(name__iexact="rear")).only("object_id", "name", "image").order_by("pk")
    for attachment in attachments:
        key = attachment.name.lower() + "Image"
        if attachment.image and images[attachment.object_id][key] is None:
            images[attachment.object_id][key] = attachment.image.url
    return images


def _images(layout_owner, user=None):
    if isinstance(layout_owner, ModuleType):
        if user is not None:
            return _module_images(user, [layout_owner.pk])[layout_owner.pk]
        return {"frontImage": None, "rearImage": None}
    return {
        "frontImage": layout_owner.front_image.url if layout_owner.front_image else None,
        "rearImage": layout_owner.rear_image.url if layout_owner.rear_image else None,
    }


def _layout_ports(user, owner_filter):
    ports = {}
    for kind, (model, _, fixed_face) in LAYOUT_PORTS.items():
        templates = model.objects.restrict(user).filter(**owner_filter)
        if kind == "interface":
            templates = templates.exclude(type__in=NONCONNECTABLE_IFACE_TYPES)
        for pk, name, label in templates.order_by("name", "pk").values_list("pk", "name", "label"):
            key = pk if kind == "interface" else f"{kind}:{pk}"
            ports[key] = {"id": key, "name": name, "label": label, "kind": kind, "fixedFace": fixed_face}
    return ports


def _layout_bays(user, owner_filter):
    return dict(
        ModuleBayTemplate.objects.restrict(user).filter(**owner_filter).order_by("name", "pk").values_list("pk", "name")
    )


def _visible_layout_design(design, bay_ids):
    return {
        face: {
            "useImage": options["useImage"],
            "items": [item for item in options["items"] if item["kind"] != "bay" or item["bay"] in bay_ids],
        }
        for face, options in design.items()
    }


def layout_designs(user, device_type_ids, module_type_ids):
    device_types = DeviceType.objects.restrict(user).filter(pk__in=device_type_ids).values("pk")
    module_types = ModuleType.objects.restrict(user).filter(pk__in=module_type_ids).values("pk")
    matches = Q(device_type_id__in=device_types) | Q(module_type_id__in=module_types)
    bays = defaultdict(set)
    for pk, device_id, module_id in ModuleBayTemplate.objects.restrict(user).filter(matches).values_list(
        "pk", "device_type_id", "module_type_id",
    ):
        bays[(device_id, module_id)].add(pk)
    device_designs, module_designs = {}, {}
    for device_id, module_id, design in LayoutRevision.objects.filter(matches).values_list(
        "device_type_id", "module_type_id", "design",
    ):
        if not design:
            continue
        visible = _visible_layout_design(design, bays[(device_id, module_id)])
        if device_id is not None:
            device_designs[device_id] = visible
        else:
            module_designs[module_id] = visible
    return device_designs, module_designs


def _layout_port_identity(key):
    if type(key) is int and 0 < key < 2**63:
        return "interface", key
    if isinstance(key, str) and (match := re.fullmatch(r"(front-port|rear-port):([1-9][0-9]{0,18})", key)):
        pk = int(match[2])
        if pk < 2**63:
            return match[1], pk
    return None


def _layout_placements(ports):
    ids = defaultdict(list)
    for key in ports:
        kind, pk = _layout_port_identity(key)
        ids[kind].append(pk)
    matches = Q()
    for kind, (_, field, _) in LAYOUT_PORTS.items():
        matches |= Q(**{f"{field}__in": ids[kind]})
    return PortPlacement.objects.filter(matches)


def _placement_data(placement):
    for kind, (_, field, _) in LAYOUT_PORTS.items():
        if (pk := getattr(placement, field)) is not None:
            key = pk if kind == "interface" else f"{kind}:{pk}"
            point = {"port_id": key, "face": placement.face, "x": placement.x, "y": placement.y}
            if placement.label:
                point["label"] = placement.label
            return point


def _can_edit_layout(user, owner):
    return (
        user.is_authenticated
        and type(owner).objects.restrict(user, "change").filter(pk=owner.pk).exists()
    )


@require_GET
def layout_editor(request, pk, kind="device"):
    model, field, label, save_route = LAYOUT_TYPES[kind]
    owner = get_object_or_404(model.objects.restrict(request.user), pk=pk)
    owner_filter = {field: owner}
    layout = LayoutRevision.objects.filter(**owner_filter).first()
    ports = _layout_ports(request.user, owner_filter)
    bays = _layout_bays(request.user, owner_filter)
    placements = [_placement_data(placement) for placement in _layout_placements(ports)]
    return render(request, "nbcableeditor/layout.html", {
        "device_type": owner,
        "layout_owner": owner,
        "layout_kind_label": label,
        "is_module_type": kind == "module",
        "editor_version": NbCableEditorConfig.version,
        "layout_templates": templates_for(kind),
        "layout_data": {
            **_images(owner, request.user),
            "layoutKind": kind,
            "layoutName": str(owner),
            "layoutHeight": float(owner.u_height) if kind == "device" else None,
            "placeholderFields": layout_placeholder_fields(owner),
            "bays": [{"id": bay_id, "name": name} for bay_id, name in bays.items()],
            "design": _visible_layout_design(layout.design, bays) if layout else {},
            "ports": list(ports.values()),
            "placements": placements,
            "canEdit": _can_edit_layout(request.user, owner),
            "revision": layout.revision if layout else 0,
        },
        "save_url": _route(save_route, pk),
    })


def _parse_layout(raw):
    if len(raw) > MAX_LAYOUT_BYTES:
        raise ValueError("The port layout is too large.")
    body = json.loads(raw)
    if (
        not isinstance(body, dict)
        or type(body.get("revision")) is not int
        or body["revision"] < 0
        or not isinstance(body.get("placements"), list)
    ):
        raise ValueError("Expected a revision and a list of port placements.")
    placements = {}
    for point in body["placements"]:
        if not isinstance(point, dict):
            raise ValueError("Each port placement must be an object.")
        port_id, face, x, y = (point.get(key) for key in ("port_id", "face", "x", "y"))
        identity = _layout_port_identity(port_id)
        if identity is None or port_id in placements:
            raise ValueError("Each port must appear at most once and have a valid ID.")
        if face not in LAYOUT_FACES or not all(type(n) in (int, float) and 0 <= n <= 1 for n in (x, y)):
            raise ValueError("Choose a front or rear face and coordinates between 0 and 1.")
        kind, pk = identity
        _, field, fixed_face = LAYOUT_PORTS[kind]
        if fixed_face and face != fixed_face:
            raise ValueError("Front and rear ports must stay on their corresponding device face.")
        label = point.get("label", "")
        if not isinstance(label, str) or len(label) > 64 or "\x00" in label:
            raise ValueError("A port label must contain at most 64 characters.")
        label.encode("utf-8")
        placements[port_id] = PortPlacement(**{field: pk}, face=face, x=x, y=y, label=label)
    return body["revision"], placements, _parse_layout_design(body["design"]) if "design" in body else None


def _parse_layout_design(design):
    if not isinstance(design, dict) or design.keys() - set(LAYOUT_FACES):
        raise ValueError("Designs can contain a front and a rear face.")
    validated = {}
    for face, options in design.items():
        if not isinstance(options, dict) or type(options.get("useImage")) is not bool:
            raise ValueError("Choose whether to use the image for each face.")
        items = options.get("items")
        if not isinstance(items, list) or len(items) > MAX_DESIGN_ITEMS_PER_FACE:
            raise ValueError(f"Each face can contain up to {MAX_DESIGN_ITEMS_PER_FACE} design objects.")
        clean_items = []
        bays = set()
        for item in items:
            clean = _parse_design_item(item)
            if clean["kind"] == "bay":
                if clean["bay"] in bays:
                    raise ValueError("A module bay may be drawn only once per face.")
                bays.add(clean["bay"])
            clean_items.append(clean)
        validated[face] = {"useImage": options["useImage"], "items": clean_items}
    return validated


def _parse_design_color(value):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError("Use a six-digit hex color such as #FFFFFF.")
    return value.upper()


def _parse_design_text(item):
    text, font, size = (item.get(key) for key in ("text", "font", "size"))
    if not isinstance(text, str) or not text.strip() or len(text) > 256 or "\x00" in text:
        raise ValueError("Enter text with at most 256 characters.")
    text.encode("utf-8")
    if font not in LAYOUT_FONTS or type(size) not in (int, float) or not 8 <= size <= 96:
        raise ValueError("Choose a supported font and a size from 8 to 96.")
    return {"text": text, "font": font, "size": size}


def _parse_rectangle_label(label):
    if not isinstance(label, dict) or label.get("position") not in LAYOUT_LABEL_POSITIONS:
        raise ValueError("Choose a valid rectangle label position.")
    clean = {**_parse_design_text(label), "position": label["position"]}
    if (color := _parse_design_color(label.get("color"))) is not None:
        clean["color"] = color
    return clean


def _parse_design_item(item):
    if not isinstance(item, dict) or item.get("kind") not in ("text", "rectangle", "bay"):
        raise ValueError("Each design object must be text, a rectangle or a module bay.")
    kind, x, y = (item.get(key) for key in ("kind", "x", "y"))
    if not all(type(n) in (int, float) and 0 <= n <= 1 for n in (x, y)):
        raise ValueError("Place design objects within the face.")
    clean = {"kind": kind, "x": x, "y": y}
    if (color := _parse_design_color(item.get("color"))) is not None:
        clean["color"] = color
    if kind == "text":
        return {**clean, **_parse_design_text(item)}
    width, height = item.get("width"), item.get("height")
    if (
        not all(type(n) in (int, float) and 0 < n <= 1 for n in (width, height))
        or max(x, y) == 1
        or x + width > 1 + 1e-9
        or y + height > 1 + 1e-9
    ):
        raise ValueError("Keep the entire rectangle or bay inside the face.")
    clean.update(width=min(width, 1 - x), height=min(height, 1 - y))
    if kind == "rectangle":
        if (border := _parse_design_color(item.get("borderColor"))) is not None:
            clean["borderColor"] = border
        if (label := item.get("label")) is not None:
            clean["label"] = _parse_rectangle_label(label)
    else:
        bay, module_face = item.get("bay"), item.get("moduleFace", "front")
        if type(bay) is not int or not 0 < bay < 2**63 or module_face not in LAYOUT_FACES:
            raise ValueError("Choose a module bay and a valid module face.")
        clean.update(bay=bay, moduleFace=module_face)
    return clean


@require_POST
@csrf_protect
def save_layout(request, pk, kind="device"):
    model, field, label, _ = LAYOUT_TYPES[kind]
    if request.content_type != "application/json":
        return JsonResponse({"error": "Send the layout as JSON."}, status=415)
    try:
        revision, placements, design = _parse_layout(request.body)
    except (json.JSONDecodeError, UnicodeError, RecursionError):
        return JsonResponse({"error": "The port layout is not valid JSON."}, status=400)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    try:
        with transaction.atomic():
            owner = get_object_or_404(
                model.objects.restrict(request.user).select_for_update(of=("self",)), pk=pk
            )
            if not _can_edit_layout(request.user, owner):
                return JsonResponse({"error": f"You cannot change this {label.lower()}."}, status=403)
            owner_filter = {field: owner}
            layout = LayoutRevision.objects.filter(**owner_filter).first()
            if revision != (layout.revision if layout else 0):
                return JsonResponse(
                    {"error": "The layout has changed. Reload before editing it again."}, status=409
                )
            allowed_ports = _layout_ports(request.user, owner_filter)
            if placements.keys() - allowed_ports.keys():
                return JsonResponse({"error": f"A port is no longer available for this {label.lower()}."}, status=400)
            updated_design = layout.design.copy() if layout else {}
            if design is not None:
                allowed_bays = _layout_bays(request.user, owner_filter)
                for face, options in design.items():
                    if any(item["kind"] == "bay" and item["bay"] not in allowed_bays for item in options["items"]):
                        return JsonResponse({"error": "A module bay is no longer available for this layout."}, status=400)
                    hidden_bays = [
                        item for item in updated_design.get(face, {}).get("items", [])
                        if item["kind"] == "bay" and item["bay"] not in allowed_bays
                    ]
                    updated_design[face] = {**options, "items": options["items"] + hidden_bays}
            # An editor with restricted template permissions only replaces their visible subset.
            _layout_placements(allowed_ports).delete()
            PortPlacement.objects.bulk_create(placements.values())
            revision += 1
            LayoutRevision.objects.update_or_create(
                **owner_filter, defaults={"revision": revision, "design": updated_design},
            )
    except IntegrityError:
        return JsonResponse({"error": f"The {label.lower()} changed during the save. Reload and retry."}, status=409)
    return JsonResponse({"revision": revision})


def _vlan_data_for_ports(user, ports):
    ports = list(ports)
    readable = VLAN.objects.restrict(user).only("vid", "name", "custom_field_data")
    prefetch_related_objects(
        ports,
        Prefetch("untagged_vlan", queryset=readable, to_attr="_rack_untagged_vlan"),
        Prefetch(
            "tagged_vlans",
            queryset=readable.order_by("vid", "name", "pk"),
            to_attr="_rack_tagged_vlans",
        ),
    )

    def vlan_data(vlan):
        data = {"vid": vlan.vid, "name": vlan.name}
        color = vlan.custom_field_data.get("editorColorHex")
        if isinstance(color, str) and re.fullmatch(r"#[0-9A-Fa-f]{6}", color):
            data["color"] = color.upper()
        return data

    return {
        port.pk: {
            "vlanMode": port.mode or "",
            "vlanModeDisplay": port.get_mode_display() or "",
            "untaggedVlan": vlan_data(port._rack_untagged_vlan) if port._rack_untagged_vlan else None,
            "taggedVlans": [vlan_data(vlan) for vlan in port._rack_tagged_vlans],
        }
        for port in ports
    }


def _single_ends(terminations):
    sides = defaultdict(list)
    for termination in terminations:
        sides[termination.cable_end].append(termination)
    return tuple(sides[side][0] if len(sides[side]) == 1 else None for side in ("A", "B"))


def _port_on_cable(ports, port_id, cable_id):
    port = ports.get(port_id)
    return port if port is not None and port.cable_id == cable_id else None


def _immediate_endpoint(key, cable_id, rack_id, nodes, endpoints):
    port = _port_on_cable(nodes, key, cable_id)
    if port is None or port.device.rack_id == rack_id:
        return None
    return endpoints[key]


def _rack_object_tags(obj, catalog):
    return [catalog[tag.pk] for tag in obj.tags.all() if tag.pk in catalog]


def _rack_connection_data(user, rack_id, devices, ports, tag_catalog, custom_fields):
    interfaces = {port.pk: port for port in ports.values() if isinstance(port, Interface)}
    cable_ids = {port.cable_id for port in ports.values() if port.cable_id is not None}
    if not cable_ids:
        return [], _vlan_data_for_ports(user, interfaces.values())
    change_ids = set(
        Cable.objects.restrict(user, "change").filter(pk__in=cable_ids).values_list("pk", flat=True)
    )
    delete_ids = set(
        Cable.objects.restrict(user, "delete").filter(pk__in=cable_ids).values_list("pk", flat=True)
    )
    types = ObjectType.objects.get_for_models(Cable, Interface, FrontPort, RearPort)
    cable_type = types[Cable]
    port_models = {types[model].pk: model for model in PORT_KINDS}
    pass_through_types = {types[FrontPort].pk, types[RearPort].pk}
    dependent_records = (
        Exists(JournalEntry.objects.filter(assigned_object_type=cable_type, assigned_object_id=OuterRef("pk")))
        | Exists(Bookmark.objects.filter(object_type=cable_type, object_id=OuterRef("pk")))
        | Exists(Subscription.objects.filter(object_type=cable_type, object_id=OuterRef("pk")))
    )
    records = []
    refs = set()
    known_cables = {}
    for cable in Cable.objects.restrict(user).filter(pk__in=cable_ids).annotate(
        has_dependent_records=dependent_records
    ).prefetch_related("terminations__termination_type", "tags").order_by("pk"):
        known_cables[cable.pk] = cable
        terminations = list(cable.terminations.all())
        term_a, term_b = _single_ends(terminations)
        simple = is_simple_cable(cable, terminations)

        def local_port(term):
            model = port_models.get(term.termination_type_id) if term else None
            if model:
                return _port_on_cable(ports, port_key(model, term.termination_id), cable.pk)
            return None

        def peer_ref(term, opposite):
            if opposite and term and (simple or term.termination_type_id in pass_through_types):
                key = (term.termination_type_id, term.termination_id)
                refs.add(key)
                return key
            return None

        end_a, end_b = local_port(term_a), local_port(term_b)
        peer_a = peer_ref(term_a, end_b) if not end_a else None
        peer_b = peer_ref(term_b, end_a) if not end_b else None
        trace_a = native_path(end_b, cable.pk, types)
        trace_b = native_path(end_a, cable.pk, types)
        for trace in (trace_a, trace_b):
            if trace:
                refs.update(key for group in trace[0] for key in group)
        records.append((cable, end_a, end_b, peer_a, peer_b, simple, trace_a, trace_b))

    nodes, links = readable_nodes(user, types, refs, ports, known_cables)
    interfaces.update({port.pk: port for port in nodes.values() if isinstance(port, Interface)})
    vlans = _vlan_data_for_ports(user, interfaces.values())
    endpoints = endpoint_data(user, nodes, vlans, devices, ports)
    custom_values = cable_custom_values(user, known_cables.values(), custom_fields)
    cables = []
    for cable, end_a, end_b, peer_a, peer_b, simple, trace_a, trace_b in records:
        simple_in_rack = bool(end_a and end_b and simple)
        cables.append({
            "id": cable.pk,
            "a": port_key(type(end_a), end_a.pk) if end_a else None,
            "b": port_key(type(end_b), end_b.pk) if end_b else None,
            "endpointA": _immediate_endpoint(peer_a, cable.pk, rack_id, nodes, endpoints),
            "endpointB": _immediate_endpoint(peer_b, cable.pk, rack_id, nodes, endpoints),
            "traceA": trace_payload(trace_a, cable.pk, cable_type.pk, endpoints, links),
            "traceB": trace_payload(trace_b, cable.pk, cable_type.pk, endpoints, links),
            **cable_details(cable),
            **({"custom_fields": custom_values[cable.pk]} if custom_fields else {}),
            "tags": _rack_object_tags(cable, tag_catalog),
            "profile": cable.get_profile_display() if cable.profile else "",
            "url": cable.get_absolute_url(),
            "metadataEditable": cable.pk in change_ids,
            "editable": bool(
                simple_in_rack and cable.pk in change_ids
                and not port_unavailable(end_a) and not port_unavailable(end_b)
            ),
            "deletable": simple_in_rack and cable.pk in delete_ids and not cable.has_dependent_records,
        })
    return cables, vlans


def _occupancy(port):
    if port.cable_id is not None:
        return "cabled"
    if port.mark_connected:
        return "marked"
    if isinstance(port, Interface) and (
        port.wireless_link_id is not None or hasattr(port, "virtual_circuit_termination")
    ):
        return "other"
    return "free"


@require_GET
def rack_editor(request, pk):
    return render(request, "nbcableeditor/rack.html", _nbcableeditor_context(request, pk))


@override("en")
def _nbcableeditor_context(request, pk):
    # Match the editor's English labels while letting the NetBox page use its own language.
    user = request.user
    rack = get_object_or_404(Rack.objects.restrict(user), pk=pk)
    editor_settings, custom_fields = nbcableeditor_options()
    devices = list(
        Device.objects.restrict(user).filter(rack=rack)
        .select_related("device_type__manufacturer").order_by("name", "pk")
    )
    device_map = {device.pk: device for device in devices}
    type_ids = {device.device_type_id for device in devices}
    visible_types = set(
        DeviceType.objects.restrict(user).filter(pk__in=type_ids).values_list("pk", flat=True)
    )
    by_template, by_module_template, artwork = rack_layouts(
        user, devices, visible_types, LAYOUT_PORTS, layout_designs, _module_images,
    )

    tag_catalogs = {model: {tag.pk: tag_data(tag) for tag in available_tags(rack._state.db, user, model)}
                    for model in (Cable, *PORT_KINDS)}
    ports = {}
    editable_ports = {}
    for model in PORT_KINDS:
        queryset = model.objects.restrict(user).filter(device_id__in=device_map).prefetch_related("tags").order_by("device_id", "name", "pk")
        if model is Interface:
            queryset = queryset.select_related("virtual_circuit_termination", "_path")
        ports.update({port_key(model, port.pk): port for port in queryset})
        editable_ports[model] = set(model.objects.restrict(user, "change").filter(device_id__in=device_map).values_list("pk", flat=True))
    cables, vlans = _rack_connection_data(user, rack.pk, device_map, ports, tag_catalogs[Cable], custom_fields)
    visible_cable_ids = {cable["id"] for cable in cables}
    can_add = user.has_perm("dcim.add_cable")
    native_cable_add = reverse("dcim:cable_add") if can_add else None
    by_device = defaultdict(list)
    for key, port in ports.items():
        device = device_map[port.device_id]
        kind = PORT_KINDS[type(port)]
        is_interface = isinstance(port, Interface)
        placement = (
            by_template.get((kind, device.device_type_id, port.name))
            if port.module_id is None
            else by_module_template.get((port.module_id, kind, port.name))
        )
        cable_visible = port.cable_id in visible_cable_ids
        occupancy = _occupancy(port)
        blocked = port_unavailable(port) or (port.cable_id is not None and not cable_visible)
        manual_connect_url = None
        if native_cable_add and occupancy == "free" and not blocked:
            params = urlencode({
                "a_terminations_type": port._meta.label_lower,
                "a_terminations": port.pk,
                "b_terminations_type": Interface._meta.label_lower,
            })
            manual_connect_url = f"{native_cable_add}?{params}"
        by_device[device.pk].append({
            "id": key,
            **port_metadata(port),
            "name": port.name,
            "url": port.get_absolute_url(),
            "tags": _rack_object_tags(port, tag_catalogs[type(port)]),
            "metadataEditable": port.pk in editable_ports[type(port)],
            **({
                **vlans[port.pk],
                "speedKbps": port.speed,
                "duplex": port.get_duplex_display() or "",
                "mtu": port.mtu,
                "managementOnly": port.mgmt_only,
            } if is_interface else {
                "vlanMode": "", "vlanModeDisplay": "", "untaggedVlan": None, "taggedVlans": [],
            }),
            **(placement or {"face": LAYOUT_PORTS[kind][2], "x": None, "y": None}),
            "cableId": port.cable_id if cable_visible else None,
            "occupancy": occupancy,
            "blocked": blocked,
            "manualConnectUrl": manual_connect_url,
        })

    return {
        "rack": rack,
        "cable_url": _route("cables", pk),
        "port_url": _route("ports", pk),
        "cable_color_palette": CABLE_COLOR_PALETTE,
        "editor_version": NbCableEditorConfig.version,
        "can_manage_editor_settings": can_manage_editor_settings(user),
        "rack_zoom_choices": ZOOM_CHOICES,
        "rack_data": {
            "settings": editor_settings,
            "height": rack.u_height,
            "startingUnit": rack.starting_unit,
            "descUnits": rack.desc_units,
            "devices": [
                {
                    "id": device.pk,
                    "name": str(device),
                    "deviceType": device.device_type.model if device.device_type_id in visible_types else None,
                    "position": float(device.position) if device.position is not None else None,
                    "height": float(device.device_type.u_height),
                    "face": device.face or None,
                    "fullDepth": device.device_type.is_full_depth,
                    **_images(device.device_type),
                    "design": artwork.get(device.pk, {}),
                    "layoutUrl": _route("layout", device.device_type_id) if device.device_type_id in visible_types else None,
                    "url": device.get_absolute_url(),
                    "ports": by_device[device.pk],
                }
                for device in devices
            ],
            "cables": cables,
            "availableTags": {
                "cable": list(tag_catalogs[Cable].values()) if any(cable["metadataEditable"] for cable in cables) else [],
                **{kind: list(tag_catalogs[model].values()) if editable_ports[model] else []
                   for model, kind in PORT_KINDS.items()},
            },
            "cableTypes": [
                {"value": value, "label": str(label)} for value, label in Cable._meta.get_field("type").flatchoices
                if value
            ],
            "cableStatuses": [
                {"value": value, "label": str(label)} for value, label in Cable._meta.get_field("status").flatchoices
            ],
            "cableLengthUnits": [
                {"value": value, "label": str(label)} for value, label in Cable._meta.get_field("length_unit").flatchoices
            ],
            "canAdd": can_add,
            "canChange": user.has_perm("dcim.change_cable"),
            "canDelete": user.has_perm("dcim.delete_cable"),
            "history": history_for_rack(user, rack.pk),
        },
    }
