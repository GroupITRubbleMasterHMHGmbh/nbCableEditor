import json
import re
from collections import defaultdict

from core.models import ObjectType
from dcim.constants import NONCONNECTABLE_IFACE_TYPES
from dcim.models import (
    Cable, Device, DeviceType, FrontPort, FrontPortTemplate, Interface, InterfaceTemplate, Rack,
    RearPort, RearPortTemplate,
)
from django.db import IntegrityError, transaction
from django.db.models import Exists, OuterRef, Prefetch, Q, prefetch_related_objects
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, render
from django.urls import reverse
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_GET, require_POST
from extras.models import Bookmark, JournalEntry, Subscription
from ipam.models import VLAN

from . import RackEditorConfig
from .cable_history import history_for_rack
from .cable_views import is_simple_cable, port_key, port_unavailable
from .models import LayoutRevision, PortPlacement
from .rack_traces import PORT_KINDS, endpoint_data, native_path, readable_nodes, trace_payload


MAX_LAYOUT_BYTES = 512 * 1024
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
    return reverse(f"plugins:netbox_rack_editor:{name}", args=[pk])


def _images(device_type):
    return {
        "frontImage": device_type.front_image.url if device_type.front_image else None,
        "rearImage": device_type.rear_image.url if device_type.rear_image else None,
    }


def _layout_ports(user, device_type):
    ports = {}
    for kind, (model, _, fixed_face) in LAYOUT_PORTS.items():
        templates = model.objects.restrict(user).filter(device_type=device_type)
        if kind == "interface":
            templates = templates.exclude(type__in=NONCONNECTABLE_IFACE_TYPES)
        for pk, name, label in templates.order_by("name", "pk").values_list("pk", "name", "label"):
            key = pk if kind == "interface" else f"{kind}:{pk}"
            ports[key] = {"id": key, "name": name, "label": label, "kind": kind, "fixedFace": fixed_face}
    return ports


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
            return {"port_id": key, "face": placement.face, "x": placement.x, "y": placement.y}


def _can_edit_layout(user, device_type):
    return (
        user.is_authenticated
        and DeviceType.objects.restrict(user, "change").filter(pk=device_type.pk).exists()
    )


def _layout_revision(device_type_id):
    return (
        LayoutRevision.objects.filter(device_type_id=device_type_id)
        .values_list("revision", flat=True)
        .first()
        or 0
    )


@require_GET
def layout_editor(request, pk):
    device_type = get_object_or_404(DeviceType.objects.restrict(request.user), pk=pk)
    revision = _layout_revision(pk)
    ports = _layout_ports(request.user, device_type)
    placements = [_placement_data(placement) for placement in _layout_placements(ports)]
    return render(request, "netbox_rack_editor/layout.html", {
        "device_type": device_type,
        "editor_version": RackEditorConfig.version,
        "layout_data": {
            **_images(device_type),
            "ports": list(ports.values()),
            "placements": placements,
            "canEdit": _can_edit_layout(request.user, device_type),
            "revision": revision,
        },
        "save_url": _route("placements", pk),
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
        if face not in ("front", "rear") or not all(type(n) in (int, float) and 0 <= n <= 1 for n in (x, y)):
            raise ValueError("Choose a front or rear face and coordinates between 0 and 1.")
        kind, pk = identity
        _, field, fixed_face = LAYOUT_PORTS[kind]
        if fixed_face and face != fixed_face:
            raise ValueError("Front and rear ports must stay on their corresponding device face.")
        placements[port_id] = PortPlacement(**{field: pk}, face=face, x=x, y=y)
    return body["revision"], placements


@require_POST
@csrf_protect
def save_layout(request, pk):
    if request.content_type != "application/json":
        return JsonResponse({"error": "Send the layout as JSON."}, status=415)
    try:
        revision, placements = _parse_layout(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError, RecursionError):
        return JsonResponse({"error": "The port layout is not valid JSON."}, status=400)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    try:
        with transaction.atomic():
            device_type = get_object_or_404(
                DeviceType.objects.restrict(request.user).select_for_update(), pk=pk
            )
            if not _can_edit_layout(request.user, device_type):
                return JsonResponse({"error": "You cannot change this device type."}, status=403)
            if revision != _layout_revision(pk):
                return JsonResponse(
                    {"error": "The layout has changed. Reload before editing it again."}, status=409
                )
            allowed_ports = _layout_ports(request.user, device_type)
            if placements.keys() - allowed_ports.keys():
                return JsonResponse({"error": "A port is no longer available for this device type."}, status=400)
            # An editor with restricted template permissions only replaces their visible subset.
            _layout_placements(allowed_ports).delete()
            PortPlacement.objects.bulk_create(placements.values())
            revision += 1
            LayoutRevision.objects.update_or_create(device_type=device_type, defaults={"revision": revision})
    except IntegrityError:
        return JsonResponse({"error": "The device type changed during the save. Reload and retry."}, status=409)
    return JsonResponse({"revision": revision})


def _vlan_data_for_ports(user, ports):
    ports = list(ports)
    readable = VLAN.objects.restrict(user).only("vid", "name")
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
        return {"vid": vlan.vid, "name": vlan.name}

    return {
        port.pk: {
            "vlanMode": port.mode or "",
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


def _rack_connection_data(user, rack_id, devices, ports):
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
    ).prefetch_related("terminations__termination_type").order_by("pk"):
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
            "label": cable.label,
            "color": cable.color,
            "status": cable.get_status_display(),
            "statusValue": cable.status,
            "type": cable.get_type_display() if cable.type else "",
            "typeValue": cable.type or "",
            "description": cable.description,
            "length": (
                f"{cable.length} {cable.get_length_unit_display() or ''}".strip()
                if cable.length is not None else None
            ),
            "profile": cable.get_profile_display() if cable.profile else "",
            "url": cable.get_absolute_url(),
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
    user = request.user
    rack = get_object_or_404(Rack.objects.restrict(user), pk=pk)
    devices = list(
        Device.objects.restrict(user).filter(rack=rack)
        .select_related("device_type__manufacturer").order_by("name", "pk")
    )
    device_map = {device.pk: device for device in devices}
    type_ids = {device.device_type_id for device in devices}
    visible_types = set(
        DeviceType.objects.restrict(user).filter(pk__in=type_ids).values_list("pk", flat=True)
    )
    by_template = {}
    for kind, (_, field, _) in LAYOUT_PORTS.items():
        relation = field.removesuffix("_id")
        placements = PortPlacement.objects.filter(
            **{f"{relation}__device_type_id__in": type_ids},
        ).select_related(relation)
        for placement in placements:
            template = getattr(placement, relation)
            by_template[kind, template.device_type_id, template.name] = placement

    ports = {}
    for model in PORT_KINDS:
        queryset = model.objects.restrict(user).filter(device_id__in=device_map).order_by("device_id", "name", "pk")
        if model is Interface:
            queryset = queryset.select_related("virtual_circuit_termination", "_path")
        ports.update({port_key(model, port.pk): port for port in queryset})
    cables, vlans = _rack_connection_data(user, rack.pk, device_map, ports)
    visible_cable_ids = {cable["id"] for cable in cables}
    by_device = defaultdict(list)
    for key, port in ports.items():
        device = device_map[port.device_id]
        kind = PORT_KINDS[type(port)]
        placement = by_template.get((kind, device.device_type_id, port.name)) if port.module_id is None else None
        cable_visible = port.cable_id in visible_cable_ids
        by_device[device.pk].append({
            "id": key,
            "kind": kind,
            "name": port.name,
            "label": port.label,
            "description": port.description,
            "type": port.get_type_display(),
            "url": port.get_absolute_url(),
            **(vlans[port.pk] if isinstance(port, Interface) else {
                "vlanMode": "", "untaggedVlan": None, "taggedVlans": [],
            }),
            "face": placement.face if placement else LAYOUT_PORTS[kind][2],
            "x": placement.x if placement else None,
            "y": placement.y if placement else None,
            "cableId": port.cable_id if cable_visible else None,
            "enabled": port.enabled if isinstance(port, Interface) else True,
            "occupancy": _occupancy(port),
            "blocked": port_unavailable(port) or (port.cable_id is not None and not cable_visible),
        })

    return render(request, "netbox_rack_editor/rack.html", {
        "rack": rack,
        "cable_url": _route("cables", pk),
        "cable_color_palette": CABLE_COLOR_PALETTE,
        "editor_version": RackEditorConfig.version,
        "rack_data": {
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
                    "layoutUrl": _route("layout", device.device_type_id) if device.device_type_id in visible_types else None,
                    "url": device.get_absolute_url(),
                    "ports": by_device[device.pk],
                }
                for device in devices
            ],
            "cables": cables,
            "cableTypes": [
                {"value": value, "label": label} for value, label in Cable._meta.get_field("type").flatchoices
                if value
            ],
            "cableStatuses": [
                {"value": value, "label": label} for value, label in Cable._meta.get_field("status").flatchoices
            ],
            "canAdd": user.has_perm("dcim.add_cable"),
            "canChange": user.has_perm("dcim.change_cable"),
            "canDelete": user.has_perm("dcim.delete_cable"),
            "history": history_for_rack(user, rack.pk),
        },
    })
