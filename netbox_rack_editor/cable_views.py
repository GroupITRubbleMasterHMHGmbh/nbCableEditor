import json
import re
from collections import defaultdict
from copy import deepcopy

from django.core.exceptions import ValidationError
from django.db import IntegrityError, OperationalError, router, transaction
from django.db.models import Q
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_POST

from core.models import ObjectType
from core.signals import clear_events
from dcim.choices import CableEndChoices, CableProfileChoices, CableTypeChoices, LinkStatusChoices
from dcim.constants import NONCONNECTABLE_IFACE_TYPES
from dcim.models import Cable, CableTermination, Device, FrontPort, Interface, Rack, RearPort
from extras.models import Tag
from utilities.exceptions import AbortRequest

from .cable_history import HistoryConflictError, history_payload, jump_history, lock_history, record_history


MAX_BATCH_OPERATIONS = 100
PASSIVE_PORT_MODELS = {"front-port": FrontPort, "rear-port": RearPort}
PASSIVE_PORT_KINDS = {model: kind for kind, model in PASSIVE_PORT_MODELS.items()}
PORT_MODELS = (Interface, FrontPort, RearPort)
CABLE_METADATA = (
    "type", "status", "profile", "tenant_id", "label", "color", "length_unit", "description",
    "comments", "owner_id", "custom_field_data",
)


class CableEditError(Exception):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


def port_unavailable(port):
    """Whether a port cannot be used even when no cable is present."""
    return (
        port.mark_connected
        or isinstance(port, Interface) and (
            port.type in NONCONNECTABLE_IFACE_TYPES
            or port.wireless_link_id is not None
            or hasattr(port, "virtual_circuit_termination")
        )
    )


def is_simple_cable(cable, terminations):
    """Whether the cable describes a single physical link between supported ports."""
    return (
        cable.profile in ("", CableProfileChoices.SINGLE_1C1P)
        and len(terminations) == 2
        and {end.cable_end for end in terminations} == {CableEndChoices.SIDE_A, CableEndChoices.SIDE_B}
        and all(end.termination_type.model_class() in PORT_MODELS for end in terminations)
    )


def _is_object_id(value):
    return type(value) is int and 0 < value < 2**63


def port_key(model, pk):
    """Keep legacy numeric interface keys and namespace passive port IDs."""
    return pk if model is Interface else f"{PASSIVE_PORT_KINDS[model]}:{pk}"


def _end_key(end):
    return port_key(end.termination_type.model_class(), end.termination_id)


def _port_reference(key):
    if _is_object_id(key):
        return Interface, key
    if isinstance(key, str):
        kind, _, raw_pk = key.partition(":")
        model = PASSIVE_PORT_MODELS.get(kind)
        if model and re.fullmatch(r"[1-9][0-9]{0,18}", raw_pk):
            pk = int(raw_pk)
            if _is_object_id(pk):
                return model, pk
    return None


def _port_groups(keys):
    groups = defaultdict(set)
    for key in keys:
        reference = _port_reference(key)
        if reference is None:
            raise CableEditError("The recorded cable endpoint is invalid.", 409)
        model, pk = reference
        groups[model].add(pk)
    return groups


def _request_data(request):
    if request.content_type != "application/json":
        raise CableEditError("Send an application/json request.", 415)
    try:
        data = json.loads(request.body)
    except (ValueError, RecursionError):
        raise CableEditError("Invalid JSON request.", 400) from None
    if not isinstance(data, dict):
        raise CableEditError("Invalid cable request.", 400)
    return data


def _cable_text(data, field):
    value = data[field]
    max_length = Cable._meta.get_field(field).max_length
    if not isinstance(value, str) or len(value) > max_length:
        raise CableEditError(f"The cable {field} must be at most {max_length} characters.", 400)
    if re.search(r"[\x00\ud800-\udfff]", value):
        raise CableEditError(f"The cable {field} contains an invalid character.", 400)
    return value


def _cable_fields(data, *, update=False):
    fields = {}
    if "type" in data:
        cable_type = data["type"]
        if cable_type not in (None, "") and cable_type not in CableTypeChoices.values():
            raise CableEditError("Choose a valid NetBox cable type.", 400)
        fields["type"] = cable_type or None
    if "color" in data:
        color = data["color"]
        if color is None:
            color = ""
        if not isinstance(color, str) or (color and not re.fullmatch(r"#?[0-9a-fA-F]{6}", color)):
            raise CableEditError("Enter a six-digit hexadecimal cable color.", 400)
        fields["color"] = color.removeprefix("#").lower()
    if "label" in data:
        fields["label"] = _cable_text(data, "label")
    if update:
        if "description" in data:
            fields["description"] = _cable_text(data, "description")
        if "status" in data:
            status = data["status"]
            if status not in LinkStatusChoices.values():
                raise CableEditError("Choose a valid NetBox cable status.", 400)
            fields["status"] = status
        if not fields:
            raise CableEditError("Choose at least one cable detail to update.", 400)
    return fields


def _lock_ports(db, user, rack_id, keys):
    ports = {}
    groups = _port_groups(keys)
    for model in PORT_MODELS:
        if model not in groups:
            continue
        queryset = model.objects.using(db).restrict(user).filter(pk__in=groups[model])
        if model is Interface:
            queryset = queryset.select_related("virtual_circuit_termination")
        locked = queryset.order_by("pk").select_for_update(of=("self",))
        ports.update((port_key(model, port.pk), port) for port in locked)
    device_ids = {port.device_id for port in ports.values()}
    visible_devices = set(
        Device.objects.using(db)
        .restrict(user)
        .filter(pk__in=device_ids, rack_id=rack_id)
        .order_by("pk")
        .select_for_update(of=("self",), no_key=True)
        .values_list("pk", flat=True)
    )
    if ports.keys() != keys or device_ids != visible_devices:
        raise CableEditError("A port is unavailable in this rack.", 404)
    return ports


def _allowed_cables(db, user, action):
    if not user.has_perm(f"dcim.{action}_cable"):
        raise CableEditError("You do not have permission for this cable operation.", 403)
    return Cable.objects.using(db).restrict(user, action)


def _cable_ends(db, cable):
    return CableTermination.objects.using(db).filter(cable=cable).order_by("cable_end", "pk")


def _lock_cable(db, user, allowed, cable_id):
    permitted = allowed.restrict(user).filter(pk=cable_id)
    cable = permitted.select_for_update(of=("self",)).first()
    if cable is None:
        raise CableEditError("Cable not found.", 404)
    ends = list(_cable_ends(db, cable).select_related("termination_type").select_for_update(of=("self",)))
    if not is_simple_cable(cable, ends):
        raise CableEditError("This cable no longer has two editable ends.", 409)
    return cable, ends, permitted


def _check_current_ends(cable, keys, ports, permitted):
    # Permission filters can depend on the terminations. Refresh them after taking the port locks.
    if not permitted.exists():
        raise CableEditError("Cable not found.", 404)
    if any(ports[key].cable_id != cable.pk for key in keys):
        raise CableEditError("The connection changed. Reload the rack and try again.", 409)


def _check_free_ports(db, ports, keys):
    if not keys:
        return
    groups = _port_groups(keys)
    types = ObjectType.objects.db_manager(db).get_for_models(*groups)
    terminations = Q()
    for model, ids in groups.items():
        terminations |= Q(termination_type_id=types[model].pk, termination_id__in=ids)
    if any(ports[key].cable_id is not None for key in keys) or CableTermination.objects.using(db).filter(
        terminations,
    ).exists():
        raise CableEditError("A port is already occupied. Reload the rack to see the current connections.", 409)


def _save_cable(db, cable, allowed, tags=None):
    cable.full_clean()
    cable.save(using=db)
    if tags is not None:
        cable.tags.set(tags)
    if not allowed.filter(pk=cable.pk).exists():
        raise CableEditError("The resulting connection is outside your permissions.", 403)


def _delete_cable(db, cable):
    message = "This cable has linked NetBox records and cannot be deleted in the rack editor."
    for relation in ("journal_entries", "bookmarks", "subscriptions"):
        if getattr(cable, relation).using(db).exists():
            raise CableEditError(message, 409)
    _, deleted = cable.delete(using=db)
    # A generic relation can be added concurrently without taking the Cable row lock.
    # Roll back if NetBox's collector nevertheless found any data we cannot restore.
    restorable = {"dcim.cable", "dcim.cabletermination", "extras.taggeditem"}
    if any(count and label.lower() not in restorable for label, count in deleted.items()):
        raise CableEditError(message, 409)


def _cable_snapshot(db, cable, ends=None):
    # Timestamps, terminations' database IDs and NetBox's derived length/path caches are not editable state.
    if ends is None:
        ends = _cable_ends(db, cable).select_related("termination_type")
    fields = deepcopy({name: getattr(cable, name) for name in CABLE_METADATA})
    fields["length"] = str(cable.length) if cable.length is not None else None
    return {
        "id": cable.pk,
        "fields": fields,
        "tags": list(cable.tags.using(db).order_by("pk").values_list("pk", flat=True)),
        "ends": {
            end.cable_end: {"port": _end_key(end), "connector": end.connector, "positions": end.positions}
            for end in ends
        },
    }


def _edit_cable(db, user, rack_id, data):
    requested_action = data.get("action")
    if requested_action not in (None, "delete", "update"):
        raise CableEditError("Invalid cable action.", 400)
    update_details = requested_action == "update"
    cable_id = data.get("cable_id")
    if (cable_id is not None or requested_action is not None) and not _is_object_id(cable_id):
        raise CableEditError("Invalid cable ID.", 400)

    source, target = data.get("source"), data.get("target")
    if requested_action is not None:
        action = "change" if update_details else "delete"
        keys = set()
    else:
        if _port_reference(source) is None or _port_reference(target) is None or source == target:
            raise CableEditError("Choose two different ports.", 400)
        action = "add" if cable_id is None else "change"
        keys = {source, target}

    allowed = _allowed_cables(db, user, action)

    cable = None
    before = None
    if cable_id is not None:
        cable, ends, permitted_cable = _lock_cable(db, user, allowed, cable_id)
        end_keys = {end.cable_end: _end_key(end) for end in ends}
        if requested_action is None and source not in end_keys.values():
            raise CableEditError("This cable no longer has two editable ends.", 409)
        keys.update(end_keys.values())

    ports = _lock_ports(db, user, rack_id, keys)
    if cable is not None:
        _check_current_ends(cable, end_keys.values(), ports, permitted_cable)
        before = _cable_snapshot(db, cable, ends)
        cable.snapshot()
        if action == "delete":
            _delete_cable(db, cable)
            return {"before": before, "after": None}

    if any(port_unavailable(port) for port in ports.values()):
        raise CableEditError("A port cannot accept a physical cable.", 409)

    if update_details:
        fields = _cable_fields(data, update=True)
        if all(getattr(cable, key) == value for key, value in fields.items()):
            return {"before": before, "after": before}
        for key, value in fields.items():
            setattr(cable, key, value)
        _save_cable(db, cable, allowed)
        return {"before": before, "after": _cable_snapshot(db, cable, ends)}

    _check_free_ports(db, ports, {target} if cable is not None else keys)

    if cable is None:
        cable = Cable(
            a_terminations=[ports[source]],
            b_terminations=[ports[target]],
            **_cable_fields(data),
        )
    else:
        updated = {side: ports[target if key == source else key] for side, key in end_keys.items()}
        cable.a_terminations = [updated[CableEndChoices.SIDE_A]]
        cable.b_terminations = [updated[CableEndChoices.SIDE_B]]

    _save_cable(db, cable, allowed)
    return {"before": before, "after": _cable_snapshot(db, cable)}


def _apply_cable_change(db, user, rack_id, expected, desired):
    cable_id = (expected or desired)["id"]
    action = "add" if expected is None else "delete" if desired is None else "change"
    allowed = _allowed_cables(db, user, action)
    cable = None
    current_keys = set()
    if expected is not None:
        try:
            cable, ends, permitted = _lock_cable(db, user, allowed, cable_id)
        except CableEditError as exc:
            if exc.status == 404 and not Cable.objects.using(db).filter(pk=cable_id).exists():
                raise CableEditError("The recorded cable no longer exists.", 409) from exc
            raise
        current_keys = {_end_key(end) for end in ends}
        if _cable_snapshot(db, cable, ends) != expected:
            raise CableEditError("This cable has changed since the recorded operation.", 409)
    elif Cable.objects.using(db).filter(pk=cable_id).exists():
        raise CableEditError("The original cable ID is no longer available.", 409)

    desired_keys = {end["port"] for end in desired["ends"].values()} if desired else set()
    ports = _lock_ports(db, user, rack_id, current_keys | desired_keys)
    if cable is not None:
        _check_current_ends(cable, current_keys, ports, permitted)
        cable.snapshot()

    if desired is None:
        _delete_cable(db, cable)
        return

    if any(port_unavailable(ports[key]) for key in desired_keys):
        raise CableEditError("A port cannot accept a physical cable.", 409)
    _check_free_ports(db, ports, desired_keys - current_keys)

    fields = deepcopy(desired["fields"])
    if cable is None:
        cable = Cable(pk=cable_id, **fields)
    else:
        for key, value in fields.items():
            setattr(cable, key, value)
    if expected is None or desired["ends"] != expected["ends"]:
        cable.a_terminations = [ports[desired["ends"][CableEndChoices.SIDE_A]["port"]]]
        cable.b_terminations = [ports[desired["ends"][CableEndChoices.SIDE_B]["port"]]]

    tags = None
    if expected is None or desired["tags"] != expected["tags"]:
        tags = list(Tag.objects.using(db).filter(pk__in=desired["tags"]))
        if len(tags) != len(desired["tags"]):
            raise CableEditError("A tag from the original cable is no longer available.", 409)
    _save_cable(db, cable, allowed, tags=tags)
    if _cable_snapshot(db, cable) != desired:
        raise CableEditError("The original cable state is no longer valid in NetBox.", 409)


def _batch_operations(data):
    operations = data.get("operations")
    if not isinstance(operations, list) or not 1 <= len(operations) <= MAX_BATCH_OPERATIONS:
        raise CableEditError(f"Choose between 1 and {MAX_BATCH_OPERATIONS} cable operations.", 400)
    if any(not isinstance(item, dict) or not (
        item.get("action") == "delete" or (item.get("action") is None and item.get("cable_id") is None)
    ) for item in operations):
        raise CableEditError("A batch can only create or delete cables.", 400)
    return operations


def _mutate(db, user, rack_id, data):
    if not Rack.objects.using(db).restrict(user).filter(pk=rack_id).exists():
        raise CableEditError("Rack not found.", 404)
    journal = lock_history(db, user, rack_id)
    action = data.get("action")
    if action == "history":
        jump_history(
            db, journal, data.get("target"), data.get("revision"),
            lambda expected, desired: _apply_cable_change(db, user, rack_id, expected, desired),
        )
        return {"history": history_payload(journal)}, 200

    if action == "batch":
        changes = [_edit_cable(db, user, rack_id, operation) for operation in _batch_operations(data)]
        ids = [(change["after"] or change["before"])["id"] for change in changes]
        created = sum(change["before"] is None for change in changes)
        deleted = len(changes) - created
        labels = []
        if created:
            labels.append(f"Connected {created} " + ("cable" if created == 1 else "cables"))
        if deleted:
            labels.append(f"Unplugged {deleted} " + ("cable" if deleted == 1 else "cables"))
        record_history(db, journal, changes, " · ".join(labels))
        return {"ids": ids, "history": history_payload(journal)}, 200

    change = _edit_cable(db, user, rack_id, data)
    before, after = change["before"], change["after"]
    if action == "update":
        label = "Updated cable"
    else:
        label = "Created cable" if before is None else "Deleted cable" if after is None else "Moved cable"
    if before != after:
        record_history(db, journal, [change], f"{label} #{(after or before)['id']}")
    return {"id": (after or before)["id"], "history": history_payload(journal)}, 201 if before is None else 200


@require_POST
@csrf_protect
def mutate_cable(request, pk):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "Sign in to edit cables."}, status=403)
    if not _is_object_id(pk):
        return JsonResponse({"error": "Rack not found."}, status=404)

    try:
        data = _request_data(request)
    except CableEditError as exc:
        return JsonResponse({"error": str(exc)}, status=exc.status)

    db = router.db_for_write(Cable)
    try:
        with transaction.atomic(using=db):
            payload, status = _mutate(db, request.user, pk, data)
    except Exception as exc:
        # NetBox queues events in memory. They must be discarded after any rollback.
        clear_events.send(sender=Cable)
        if isinstance(exc, (CableEditError, HistoryConflictError)):
            return JsonResponse({"error": str(exc)}, status=exc.status)
        if isinstance(exc, (ValidationError, AbortRequest)):
            return JsonResponse({"error": "NetBox rejected this cable operation."}, status=409)
        if isinstance(exc, IntegrityError):
            return JsonResponse({"error": "The cable operation failed. Reload the rack and try again."}, status=409)
        # A concurrent write through NetBox's native cable editor may lock rows in a different order.
        if isinstance(exc, OperationalError) and getattr(exc.__cause__, "sqlstate", None) in {"40001", "40P01"}:
            return JsonResponse({"error": "The connection changed. Reload the rack and try again."}, status=409)
        raise

    return JsonResponse(payload, status=status)
