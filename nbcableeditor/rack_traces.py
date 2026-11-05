"""Permission-aware summaries of NetBox's cached physical cable paths."""

from collections import defaultdict

from dcim.models import Cable, Device, DeviceType, FrontPort, Interface, Rack, RearPort
from dcim.utils import decompile_path_node

from .cable_views import port_key


PORT_KINDS = {Interface: "interface", FrontPort: "front-port", RearPort: "rear-port"}
MAX_TRACE_STEPS = 60
MAX_TRACE_GROUP_SIZE = 32


def port_metadata(port):
    is_interface = isinstance(port, Interface)
    return {
        "kind": PORT_KINDS[type(port)],
        "label": port.label,
        "description": port.description,
        "type": port.get_type_display(),
        "poeMode": (port.get_poe_mode_display() or "") if is_interface else "",
        "poeType": (port.get_poe_type_display() or "") if is_interface else "",
        "enabled": port.enabled if is_interface else True,
    }


def native_path(port, cable_id, types):
    """Read the path already maintained by NetBox. Do not recalculate topology in a rack GET."""
    if not isinstance(port, Interface) or (path := port.path) is None:
        return None

    interface_type = types[Interface].pk
    cable_type = types[Cable].pk
    supported = {object_type.pk for object_type in types.values()}
    status = "split" if path.is_split else "complete" if path.is_complete else "open"
    if len(path.path) > MAX_TRACE_STEPS:
        status = "truncated"

    groups = []
    for index, step in enumerate(path.path[:MAX_TRACE_STEPS]):
        if not step:
            status = "split" if path.is_split else "open"
            break
        if not isinstance(step, list):
            status = "unsupported"
            break
        if len(step) > MAX_TRACE_GROUP_SIZE:
            status = "truncated"
            break
        try:
            group = tuple(decompile_path_node(node) for node in step)
        except (AttributeError, TypeError, ValueError):
            status = "unsupported"
            break
        if any(kind not in supported or ((kind == cable_type) != (index % 3 == 1)) for kind, _ in group):
            status = "unsupported"
            break
        groups.append(group)
        if len(group) > 1:
            status = "split"
            break

    # An absent or stale path must never be attached to a different cable.
    if groups[:2] != [((interface_type, port.pk),), ((cable_type, cable_id),)]:
        return None
    pass_through = {types[FrontPort].pk, types[RearPort].pk}
    if len(path.path) <= 3 and not any(kind in pass_through for group in groups for kind, _ in group):
        # Direct interface cables already have their two endpoints in the regular record.
        return None
    return groups, status, path.is_active


def readable_nodes(user, types, refs, rack_ports, known_cables):
    ids = defaultdict(set)
    for kind, pk in refs:
        ids[kind].add(pk)
    readable_devices = Device.objects.restrict(user).values("pk")
    port_nodes = {}
    for model in PORT_KINDS:
        kind = types[model].pk
        keys = ids[kind]
        for pk in tuple(keys):
            port = rack_ports.get(port_key(model, pk))
            if port is not None:
                port_nodes[kind, pk] = port
                keys.remove(pk)
        queryset = model.objects.restrict(user).filter(pk__in=keys, device_id__in=readable_devices)
        port_nodes.update({(kind, port.pk): port for port in queryset.select_related("device")})

    cable_type = types[Cable].pk
    cable_nodes = {pk: known_cables[pk] for pk in ids[cable_type].intersection(known_cables)}
    cable_nodes.update({
        cable.pk: cable
        for cable in Cable.objects.restrict(user)
        .filter(pk__in=ids[cable_type] - cable_nodes.keys()).only("color")
    })
    return port_nodes, cable_nodes


def endpoint_data(user, port_nodes, vlans, rack_devices, rack_ports):
    def port_device(port):
        return rack_devices.get(port.device_id) or port.device

    devices = {port_device(port).pk: port_device(port) for port in port_nodes.values()}
    type_ids = {device.device_type_id for device in devices.values()}
    rack_ids = {device.rack_id for device in devices.values() if device.rack_id is not None}
    readable_types = dict(DeviceType.objects.restrict(user).filter(pk__in=type_ids).values_list("pk", "model"))
    readable_racks = dict(Rack.objects.restrict(user).filter(pk__in=rack_ids).values_list("pk", "name"))

    endpoints = {}
    for key, port in port_nodes.items():
        device = devices[port.device_id]
        row = {
            **port_metadata(port),
            "deviceName": device.name or device.label or "Unnamed device",
            "deviceUrl": device.get_absolute_url(),
            "portName": port.name,
            "portUrl": port.get_absolute_url(),
        }
        if device.pk in rack_devices:
            row["deviceId"] = device.pk
        if isinstance(port, Interface):
            row.update(vlans[port.pk])
        rack_key = port_key(type(port), port.pk)
        if rack_key in rack_ports:
            row["portId"] = rack_key
        if device.device_type_id in readable_types:
            row["deviceType"] = readable_types[device.device_type_id]
        if device.rack_id in readable_racks:
            row["rackName"] = readable_racks[device.rack_id]
        endpoints[key] = row
    return endpoints


def trace_payload(path, cable_id, cable_type, endpoints, cables):
    if path is None:
        return None

    groups, status, active = path
    visible = []
    for group in groups:
        if any((pk not in cables if kind == cable_type else (kind, pk) not in endpoints) for kind, pk in group):
            # Hide the entire unreadable group and every downstream step.
            status = "restricted"
            break
        if len(group) != 1:
            status = "split"
            break
        visible.append(group[0])

    hops = [endpoints[key] for key in visible if key[0] != cable_type]
    segments = []
    for index in range(0, len(visible) - 2, 3):
        near, link, far = visible[index:index + 3]
        if link[1] != cable_id:
            segments.append({
                "id": link[1],
                "a": endpoints[near].get("portId"),
                "b": endpoints[far].get("portId"),
                "color": cables[link[1]].color,
            })
    result = {"status": status, "hops": hops, "segments": segments}
    if status in {"complete", "open"}:
        result["active"] = active
    return result
