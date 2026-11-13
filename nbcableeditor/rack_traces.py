"""Permission-aware summaries of NetBox's cached physical cable paths."""

from collections import defaultdict
from dataclasses import dataclass

from dcim.models import (
    Cable, CablePath, Device, DeviceType, FrontPort, Interface, Location, PortMapping, Rack, RearPort, Site, VirtualChassis,
)
from dcim.utils import compile_path_node, decompile_path_node

from .cable_views import port_key


PORT_KINDS = {Interface: "interface", FrontPort: "front-port", RearPort: "rear-port"}
NO_VLAN_DATA = {"vlanMode": "", "vlanModeDisplay": "", "untaggedVlan": None, "taggedVlans": []}
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


def _path_groups(path, types):
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
    return groups, status


def native_path(port, cable_id, types):
    """Read the path already maintained by NetBox. Do not recalculate topology in a rack GET."""
    if not isinstance(port, Interface) or (path := port.path) is None:
        return None
    groups, status = _path_groups(path, types)
    interface_type = types[Interface].pk
    cable_type = types[Cable].pk
    # An absent or stale path must never be attached to a different cable.
    if groups[:2] != [((interface_type, port.pk),), ((cable_type, cable_id),)]:
        return None
    pass_through = {types[FrontPort].pk, types[RearPort].pk}
    if len(path.path) <= 3 and not any(kind in pass_through for group in groups for kind, _ in group):
        # Direct interface cables already have their two endpoints in the regular record.
        return None
    return groups, status, path.is_active


def filter_paths(cable_ends, types):
    """Read cached paths that cross any of the rack's currently attached cable terminations."""
    if not cable_ends:
        return []
    cable_type = types[Cable].pk
    candidates = CablePath.objects.filter(
        _nodes__overlap=[compile_path_node(cable_type, pk) for pk in cable_ends],
    ).only("path", "is_complete", "is_split").order_by("pk")
    paths = []
    for path in candidates.iterator(chunk_size=250):
        groups, status = _path_groups(path, types)
        chain = tuple(group[0] for group in groups if len(group) == 1)
        cables = {
            index: chain[index][1]
            for index in range(1, len(chain) - 1, 3)
            if cable_ends.get(chain[index][1]) == {chain[index - 1], chain[index + 1]}
        }
        if cables:
            paths.append((chain, cables, status))
    return paths


def _readable_path_ports(chain, anchor, distance, cable_type, nodes, links, *, mappings=None):
    for position in range(anchor + distance, len(chain) if distance == 1 else -1, distance):
        ref = chain[position]
        previous = chain[position - distance]
        if ref[0] == cable_type:
            if ref[1] not in links or nodes[previous].cable_id != ref[1]:
                break
        elif ref not in nodes or (previous[0] == cable_type and nodes[ref].cable_id != previous[1]):
            break
        elif previous[0] != cable_type and mappings is not None and (previous, ref) not in mappings:
            break
        else:
            yield ref


def unmapped_passive_ends(paths, cable_ends, types, nodes):
    """Prove passive ports have no continuation without deriving new paths on a rack GET."""
    if not cable_ends:
        return set()
    candidates = {ref for ends in cable_ends.values() for ref in ends}
    candidates.update(
        chain[-1] for chain, _, status in paths if status == "open" and len(chain) % 3 == 0
    )
    terminal = set()
    for model, field in ((FrontPort, "front_port_id"), (RearPort, "rear_port_id")):
        kind = types[model].pk
        ids = {pk for node_type, pk in candidates if node_type == kind and (node_type, pk) in nodes}
        if ids:
            # A mapping that cannot be shown still prevents its port from being a terminal.
            mapped = PortMapping.objects.filter(**{f"{field}__in": ids}).order_by().values_list(field, flat=True).distinct()
            terminal.update((kind, pk) for pk in ids.difference(mapped))
    return terminal


def _terminal_port(ref, interface_type, unmapped):
    return ref[0] == interface_type or ref in unmapped


def _path_terminals(chain, status, interface_type, nodes, unmapped):
    terminals = {0} if chain[0][0] == interface_type else set()
    last = len(chain) - 1
    last_port = nodes.get(chain[last])
    # A path ending at the free side of a patch panel can be stale while a new cable is attached.
    if last_port is not None and (
        status == "complete" or (
            status == "open" and (
                _terminal_port(chain[last], interface_type, unmapped) if last % 3 == 2 else last_port.cable_id is None
            )
        )
    ):
        terminals.add(last)
    return terminals


def filter_trace_index(paths, cable_ends, types, rack_ports, nodes, links, *, unmapped=()):
    """Index the readable part of each path from its cable ends in either direction."""
    if not cable_ends:
        return {}, {}, {}
    cable_type = types[Cable].pk
    interface_type = types[Interface].pk
    models = {types[model].pk: model for model in PORT_KINDS}
    keys = {ref: port_key(models[ref[0]], ref[1]) for ref in nodes}
    cable_rows, port_rows = {}, {}
    used = {}

    def row_for(rows, key):
        return rows.setdefault(key, {"next": {}, "any": {}, "ends": {}, "along": {}})

    def merge(row, scope, refs):
        for ref in refs:
            row[scope][keys[ref]] = None
            used[keys[ref]] = ref

    def inspect(chain, index, cable_id, terminals):
        cable_row = row_for(cable_rows, cable_id)
        for anchor in (index - 1, index + 1):
            start = chain[anchor]
            if start not in keys:
                continue
            start_key = keys[start]
            source_id = nodes[start].device_id
            port_row = row_for(port_rows, start_key) if start_key in rack_ports else None
            merge(cable_row, "along", (start,))
            if port_row is not None:
                merge(port_row, "along", (start,))
            for distance in (1, -1):
                stops = list(_readable_path_ports(chain, anchor, distance, cable_type, nodes, links))
                if not stops:
                    continue
                peers = [ref for ref in stops if nodes[ref].device_id != source_id]
                boundary = len(chain) - 1 if distance == 1 else 0
                end = (stops[-1],) if boundary in terminals and stops[-1] == chain[boundary] else ()
                merge(cable_row, "along", stops)
                merge(cable_row, "ends", end)
                if port_row is not None:
                    merge(port_row, "along", stops)
                    merge(port_row, "ends", end)
                if peers:
                    merge(cable_row, "next", peers[:1])
                    merge(cable_row, "any", (*peers, start))
                    if port_row is not None:
                        merge(port_row, "next", peers[:1])
                        merge(port_row, "any", peers)

    for chain, cables, status in paths:
        terminals = _path_terminals(chain, status, interface_type, nodes, unmapped)
        for index, cable_id in cables.items():
            if cable_id in cable_ends:
                inspect(chain, index, cable_id, terminals)
    for cable_id, (a, b) in cable_ends.items():
        terminals = {index for index, ref in ((0, a), (2, b)) if _terminal_port(ref, interface_type, unmapped)}
        inspect((a, (cable_type, cable_id), b), 1, cable_id, terminals)

    def payload(rows):
        return {key: {scope: list(values) for scope, values in row.items()} for key, row in rows.items()}

    return payload(cable_rows), payload(port_rows), used


def external_destination_refs(paths, peers, rack_id, cable_type, nodes, links):
    """Start with the physical off-rack peer, then follow its readable downstream trace."""
    destinations = {}
    for cable_id, peer in peers.items():
        port = nodes.get(peer)
        if port is not None and port.cable_id == cable_id and port.device.rack_id != rack_id:
            destinations[cable_id] = {port.device_id: peer}

    for chain, cable_positions, _ in paths:
        for index, cable_id in cable_positions.items():
            if cable_id not in destinations:
                continue
            peer = peers[cable_id]
            distance = -1 if chain[index - 1] == peer else 1
            for ref in _readable_path_ports(chain, index + distance, distance, cable_type, nodes, links):
                port = nodes[ref]
                if port.device.rack_id == rack_id:
                    break
                destinations[cable_id].setdefault(port.device_id, ref)

    return {cable_id: list(refs.values()) for cable_id, refs in destinations.items()}


@dataclass(frozen=True)
class ExternalTrace:
    departure: tuple[int, int]
    destination: tuple[int, int]
    incoming: tuple[int, int] | None = None
    incoming_cable_id: int | None = None


def _trace_port_mappings(paths, departures, types, rack_ports, nodes):
    front_type, rear_type = types[FrontPort].pk, types[RearPort].pk
    candidates = set()
    for chain, _, _ in paths:
        for first, second in zip(chain[2::3], chain[3::3]):
            if (first in nodes and second in nodes and {first[0], second[0]} == {front_type, rear_type}
                    and nodes[first].device_id == nodes[second].device_id):
                front, rear = (first, second) if first[0] == front_type else (second, first)
                candidates.add((front[1], rear[1]))
    # Include local, readable mates for direct links without a cached path.
    local_front = {port.pk for port in rack_ports.values() if isinstance(port, FrontPort)}
    local_rear = {port.pk for port in rack_ports.values() if isinstance(port, RearPort)}
    departing_front = {pk for kind, pk in departures if kind == front_type}
    departing_rear = {pk for kind, pk in departures if kind == rear_type}
    front_ids = {front for front, _ in candidates} | departing_front | (local_front if departing_rear else set())
    rear_ids = {rear for _, rear in candidates} | departing_rear | (local_rear if departing_front else set())
    if not front_ids or not rear_ids:
        return set()
    mappings = set()
    rows = PortMapping.objects.filter(front_port_id__in=front_ids, rear_port_id__in=rear_ids)
    for front, rear in rows.order_by().values_list("front_port_id", "rear_port_id").distinct():
        if (front, rear) in candidates or (front in departing_front and rear in local_rear) or (
            rear in departing_rear and front in local_front
        ):
            front, rear = (front_type, front), (rear_type, rear)
            mappings.update(((front, rear), (rear, front)))
    return mappings


def external_trace_refs(paths, outside_ends, rack_id, types, rack_ports, nodes, links, *, unmapped=()):
    """Attach each proved external terminal to the last physical rack departure in its path."""
    if not outside_ends:
        return {}
    cable_type, interface_type = types[Cable].pk, types[Interface].pk
    paths = [(chain, cables, status) for chain, cables, status in paths if outside_ends.keys() & cables.values()]
    mappings = _trace_port_mappings(paths, {ends[0] for ends in outside_ends.values()}, types, rack_ports, nodes)
    mapped_mates = defaultdict(list)
    for departure, mate in mappings:
        if departure in nodes and mate in nodes and nodes[departure].device_id == nodes[mate].device_id:
            mapped_mates[departure].append(mate)
    traces = defaultdict(dict)

    def in_rack(ref):
        port = nodes[ref]
        return port_key(type(port), port.pk) in rack_ports or port.device.rack_id == rack_id

    def add(cable_id, departure, destination, incoming=None, incoming_cable_id=None):
        routes = traces[cable_id]
        if destination not in routes or (incoming and routes[destination].incoming is None):
            routes[destination] = ExternalTrace(departure, destination, incoming, incoming_cable_id)

    for chain, cables, status in paths:
        terminals = _path_terminals(chain, status, interface_type, nodes, unmapped)
        for index, cable_id in cables.items():
            if cable_id not in outside_ends:
                continue
            departure, peer = outside_ends[cable_id]
            if departure not in nodes or peer not in nodes:
                continue
            distance = 1 if chain[index - 1] == departure else -1
            boundary = len(chain) - 1 if distance == 1 else 0
            if boundary not in terminals:
                continue
            anchor = index - distance
            stops = list(_readable_path_ports(chain, anchor, distance, cable_type, nodes, links, mappings=mappings))
            if not stops or stops[-1] != chain[boundary] or any(in_rack(ref) for ref in stops):
                continue
            incoming = incoming_cable_id = None
            mate_index = anchor - distance
            incoming_index = mate_index - distance
            if 0 <= incoming_index < len(chain):
                mate = chain[mate_index]
                mate_cable = nodes[mate].cable_id if mate in mapped_mates[departure] else None
                if mate_cable in links and chain[incoming_index] == (cable_type, mate_cable):
                    incoming, incoming_cable_id = mate, mate_cable
            add(cable_id, departure, stops[-1], incoming, incoming_cable_id)

    for cable_id, (departure, peer) in outside_ends.items():
        if (departure not in nodes or peer not in nodes or nodes[departure].cable_id != cable_id
                or nodes[peer].cable_id != cable_id or in_rack(peer)
                or not _terminal_port(peer, interface_type, unmapped)):
            continue
        incoming = None
        # Without a path, a multifiber position cannot be assigned to a mapped cable.
        if getattr(nodes[departure], "positions", 1) == 1:
            mates = [mate for mate in mapped_mates[departure]
                     if nodes[mate].cable_id in links and getattr(nodes[mate], "positions", 1) == 1]
            if len(mates) == 1:
                incoming = mates[0]
        add(cable_id, departure, peer, incoming, nodes[incoming].cable_id if incoming else None)
    return {cable_id: list(entries.values()) for cable_id, entries in traces.items()}


def external_destination_data(user, refs, nodes, endpoints):
    if not refs:
        return {}
    devices = {nodes[ref].device_id: nodes[ref].device for ref in refs}
    racks = Rack.objects.restrict(user).filter(pk__in={device.rack_id for device in devices.values()})
    racks = {rack.pk: rack for rack in racks.only("name", "location")}
    location_ids = {device.location_id for device in devices.values()} | {rack.location_id for rack in racks.values()}

    def places(queryset):
        return {pk: {"id": pk, "name": name} for pk, name in queryset.values_list("pk", "name")}

    locations = places(Location.objects.restrict(user).filter(pk__in=location_ids))
    sites = places(Site.objects.restrict(user).filter(pk__in={device.site_id for device in devices.values()}))
    rows = {}
    for ref in refs:
        port, endpoint = nodes[ref], endpoints[ref]
        device = devices[port.device_id]
        rack = racks.get(device.rack_id)
        location_id = device.location_id or (rack.location_id if rack else None)
        rows[ref] = {
            "location": locations.get(location_id),
            "site": sites.get(device.site_id),
            "rack": {"id": rack.pk, "name": rack.name} if rack else None,
            "device": {"id": device.pk, "name": endpoint["deviceName"]},
            "port": {"id": port_key(type(port), port.pk), "name": endpoint["portName"]},
        }
    return rows


def external_trace_data(rack, trace_refs, nodes, destination_rows):
    def port_id(ref):
        port = nodes[ref]
        return port_key(type(port), port.pk)

    result = {}
    for cable_id, routes in trace_refs.items():
        for route in routes:
            destination = destination_rows[route.destination]
            remote = nodes[route.destination].device
            flags = {
                "otherRack": bool(destination["rack"] and destination["rack"]["id"] != rack.pk),
                "otherLocation": bool(destination["location"] and destination["location"]["id"] != rack.location_id),
                "otherSite": bool(destination["site"] and destination["site"]["id"] != rack.site_id),
                "unracked": remote.rack_id is None,
            }
            if not any(flags.values()):
                continue
            result.setdefault(cable_id, []).append({
                "departurePort": port_id(route.departure),
                "destination": {**destination, **flags},
                **({"incomingPort": port_id(route.incoming), "incomingCableId": route.incoming_cable_id}
                   if route.incoming else {}),
            })
    return result


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
        .filter(pk__in=ids[cable_type] - cable_nodes.keys())
        .only("color", "label", "type", "length", "length_unit")
    })
    return port_nodes, cable_nodes


def readable_chassis_names(user, devices):
    ids = {device.virtual_chassis_id for device in devices if not device.name and device.virtual_chassis_id}
    return dict(VirtualChassis.objects.restrict(user).filter(pk__in=ids).values_list("pk", "name"))


def device_label(device, chassis_names):
    if device.name:
        return device.name
    if chassis := chassis_names.get(device.virtual_chassis_id):
        return f"{chassis}:{device.vc_position}"
    return None


def endpoint_data(user, port_nodes, vlans, rack_devices, rack_ports):
    def port_device(port):
        return rack_devices.get(port.device_id) or port.device

    devices = {port_device(port).pk: port_device(port) for port in port_nodes.values()}
    type_ids = {device.device_type_id for device in devices.values()}
    rack_ids = {device.rack_id for device in devices.values() if device.rack_id is not None}
    readable_types = dict(DeviceType.objects.restrict(user).filter(pk__in=type_ids).values_list("pk", "model"))
    readable_racks = dict(Rack.objects.restrict(user).filter(pk__in=rack_ids).values_list("pk", "name"))
    chassis_names = readable_chassis_names(user, devices.values())

    endpoints = {}
    for key, port in port_nodes.items():
        device = devices[port.device_id]
        row = {
            **port_metadata(port),
            "deviceName": device_label(device, chassis_names) or "Unnamed device",
            "deviceUrl": device.get_absolute_url(),
            "filterDeviceId": device.pk,
            "portName": port.name,
            "portUrl": port.get_absolute_url(),
        }
        if device.pk in rack_devices:
            row["deviceId"] = device.pk
        if isinstance(port, Interface):
            row.update(vlans.get(port.pk, NO_VLAN_DATA))
        rack_key = port_key(type(port), port.pk)
        if rack_key in rack_ports:
            row["portId"] = rack_key
        if device.device_type_id in readable_types:
            row["deviceType"] = readable_types[device.device_type_id]
            row["deviceTypeId"] = device.device_type_id
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

    def report_endpoint(key):
        return {field: endpoints[key][field] for field in ("deviceName", "portName", "deviceUrl", "portUrl")}

    for index in range(0, len(visible) - 2, 3):
        near, link, far = visible[index:index + 3]
        if link[1] != cable_id:
            cable = cables[link[1]]
            segments.append({
                "id": link[1],
                "a": endpoints[near].get("portId"),
                "b": endpoints[far].get("portId"),
                "color": cable.color,
                "label": cable.label,
                "endpointA": report_endpoint(near),
                "endpointB": report_endpoint(far),
                "typeValue": cable.type or "",
                "lengthValue": str(cable.length) if cable.length is not None else None,
                "lengthUnit": cable.length_unit or "",
            })
    result = {"status": status, "hops": hops, "segments": segments}
    if status in {"complete", "open"}:
        result["active"] = active
    return result
