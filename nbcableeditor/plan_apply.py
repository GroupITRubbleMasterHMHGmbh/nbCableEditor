from copy import deepcopy
from dataclasses import dataclass

from dcim.choices import CableEndChoices, LinkStatusChoices
from dcim.models import Cable, CableTermination
from django.db.models import QuerySet
from extras.models import Tag

from .cable_history import history_payload, lock_history, record_history
from .cable_views import (
    CableEditError,
    _allowed_cables,
    _cable_fields,
    _cable_snapshot,
    _check_current_ends,
    _check_free_ports,
    _delete_cable,
    _lock_cable,
    _lock_ports,
    _save_cable,
    port_unavailable,
)


A = CableEndChoices.SIDE_A
B = CableEndChoices.SIDE_B


@dataclass
class _Change:
    allowed: QuerySet
    cable: Cable | None = None
    terminations: tuple[CableTermination, ...] = ()
    permitted: QuerySet | None = None
    before: dict | None = None
    target: dict | None = None


def _lock_change(db, user, action, cable_id):
    allowed = _allowed_cables(db, user, action)
    if action == "add":
        if cable_id is not None and Cable.objects.using(db).filter(pk=cable_id).exists():
            raise CableEditError(f"The original ID of cable #{cable_id} is no longer available.", 409)
        return _Change(allowed=allowed)
    try:
        cable, terminations, permitted = _lock_cable(db, user, allowed, cable_id)
    except CableEditError as exc:
        raise CableEditError(f"Cable #{cable_id}: {exc}", exc.status) from exc
    return _Change(allowed, cable, tuple(terminations), permitted, _cable_snapshot(db, cable, terminations))


def _keys(snapshot):
    return {end["port"] for end in snapshot["ends"].values()} if snapshot else set()


def _prepare_graph(db, user, rack_id, changes):
    current_keys = set().union(*(_keys(change.before) for change in changes))
    target_keys = set()
    for change in changes:
        if change.target is None:
            continue
        keys = _keys(change.target)
        if len(keys) != 2 or target_keys & keys:
            raise CableEditError("Two cable ends use the same target port. Choose distinct ports in the plan.", 409)
        target_keys.update(keys)

    ports = _lock_ports(db, user, rack_id, current_keys | target_keys)
    for change in changes:
        if change.cable is not None:
            _check_current_ends(change.cable, _keys(change.before), ports, change.permitted)
    if any(port_unavailable(ports[key]) for key in target_keys):
        raise CableEditError("A target port cannot accept a physical cable.", 409)
    _check_free_ports(db, ports, target_keys - current_keys)
    return ports


def _release_ports(db, changes):
    # Capture the original NetBox change logs before any terminations are removed.
    for change in changes:
        if change.cable is not None:
            change.cable.snapshot()

    # Release every vacated port before assigning any new endpoint. This also
    # allows cycles, including an A/B reversal on the same cable.
    for change in changes:
        if change.cable is None:
            continue
        if change.target is None:
            _delete_cable(db, change.cable)
            continue
        for end in change.terminations:
            side = end.cable_end
            if change.before["ends"][side] != change.target["ends"][side]:
                end.delete(using=db)


def _save_target(db, ports, change):
    target = change.target
    fields = deepcopy(target["fields"])
    cable = change.cable
    if cable is None:
        cable = Cable(pk=target.get("id"), **fields)
    else:
        for key, value in fields.items():
            setattr(cable, key, value)
    if change.before is None or change.before["ends"] != target["ends"]:
        cable.a_terminations = [ports[target["ends"][A]["port"]]]
        cable.b_terminations = [ports[target["ends"][B]["port"]]]

    tags = None
    if change.before is None or change.before["tags"] != target["tags"]:
        tags = list(Tag.objects.using(db).filter(pk__in=target["tags"]))
        if len(tags) != len(target["tags"]):
            raise CableEditError("A tag from the original cable is no longer available.", 409)
    _save_cable(db, cable, change.allowed, tags=tags)
    return _cable_snapshot(db, cable)


def _apply_graph(db, user, rack_id, changes):
    ports = _prepare_graph(db, user, rack_id, changes)
    _release_ports(db, changes)
    deltas = []
    for change in changes:
        after = _save_target(db, ports, change) if change.target is not None else None
        if after is not None and change.target.get("id") is not None and after != change.target:
            raise CableEditError(f"Cable #{after['id']} could not be restored to the expected state in NetBox.", 409)
        deltas.append({"before": change.before, "after": after})
    return deltas


def apply_rack_plan(db, user, rack_id, operations, *, status, label):
    """Apply validated operations and append one undoable entry in the caller's transaction."""
    if status not in {LinkStatusChoices.STATUS_PLANNED, LinkStatusChoices.STATUS_CONNECTED}:
        raise CableEditError("Choose Planned or Connected for new cables.", 400)

    journal = lock_history(db, user, rack_id)
    ordered = sorted(operations, key=lambda operation: operation.get("cable_id") or 0)
    changes = []
    cable_ids = set()
    for operation in ordered:
        action = operation["action"]
        cable_id = operation.get("cable_id")
        if cable_id is not None:
            if cable_id in cable_ids:
                raise CableEditError(f"Cable #{cable_id} occurs more than once in the plan.", 409)
            cable_ids.add(cable_id)
        change = _lock_change(db, user, "change" if action == "move" else action, cable_id)
        if change.before is not None:
            original = {side.lower(): end["port"] for side, end in change.before["ends"].items()}
            if original != operation["before"]:
                raise CableEditError(f"The endpoints of cable #{cable_id} changed after planning.", 409)

        if action == "add":
            change.target = {
                "fields": {**_cable_fields(operation), "status": status},
                "tags": [],
                "ends": {A: {"port": operation["a"]}, B: {"port": operation["b"]}},
            }
        elif action == "move":
            change.target = deepcopy(change.before)
            change.target["ends"][A]["port"] = operation["a"]
            change.target["ends"][B]["port"] = operation["b"]
        changes.append(change)

    deltas = _apply_graph(db, user, rack_id, changes)
    record_history(
        db, journal, [delta for delta in deltas if delta["before"] != delta["after"]], label, atomic_plan=True,
    )
    return {
        "ids": {
            operation["id"]: delta["after"]["id"] if delta["after"] else None
            for operation, delta in zip(ordered, deltas, strict=True)
        },
        "history": history_payload(journal),
    }


def replay_rack_plan(db, user, rack_id, snapshots):
    """Undo or redo the complete graph, keeping native cable identities."""
    changes = []
    for expected, target in sorted(snapshots, key=lambda pair: (pair[0] or pair[1])["id"]):
        cable_id = (expected or target)["id"]
        action = "add" if expected is None else "delete" if target is None else "change"
        change = _lock_change(db, user, action, cable_id)
        if change.before != expected:
            raise CableEditError(f"Cable #{cable_id} has changed since the plan was applied.", 409)
        change.target = target
        changes.append(change)
    _apply_graph(db, user, rack_id, changes)
