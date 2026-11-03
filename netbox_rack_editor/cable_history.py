from django.db import router, transaction

from dcim.models import Cable

from .models import CableHistoryEntry, CableHistoryJournal


class HistoryConflictError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.message = message
        self.status = status


def lock_history(db, user, rack_id):
    """Lock or create the journal inside the same transaction as the cable edit."""
    journal, _ = CableHistoryJournal.objects.using(db).select_for_update().get_or_create(
        rack_id=rack_id, user_id=user.pk,
    )
    return journal


def _move_cursor(db, journal, target):
    revision = journal.revision + 1
    CableHistoryJournal.objects.using(db).filter(pk=journal.pk).update(cursor=target, revision=revision)
    journal.cursor = target
    journal.revision = revision


def record_history(db, journal, changes, label):
    """Append one edit to the locked journal and discard its superseded redo entries."""
    if not changes:
        return
    with transaction.atomic(using=db):
        entries = CableHistoryEntry.objects.using(db).filter(journal_id=journal.pk)
        entries.filter(sequence__gt=journal.cursor).delete()
        sequence = journal.cursor + 1
        CableHistoryEntry.objects.using(db).create(
            journal_id=journal.pk, sequence=sequence, changes=changes, label=label,
        )
        _move_cursor(db, journal, sequence)


def jump_history(db, journal, target, revision, apply_change):
    """Replay the deltas needed to reach target, or roll back the entire jump."""
    if type(revision) is not int or revision < 0 or type(target) is not int or target < 0:
        raise HistoryConflictError("Choose a valid cable history checkpoint.", 400)
    if revision != journal.revision:
        raise HistoryConflictError("Cable history changed. Reload the rack and try again.")
    entries = CableHistoryEntry.objects.using(db).filter(journal_id=journal.pk)
    tip = entries.order_by("-sequence").values_list("sequence", flat=True).first() or 0
    if target > tip:
        raise HistoryConflictError("The cable history checkpoint does not exist.", 400)
    if target == journal.cursor:
        return

    with transaction.atomic(using=db):
        undo = target < journal.cursor
        start, end = sorted((target, journal.cursor))
        batches = entries.filter(sequence__gt=start, sequence__lte=end).order_by(
            "-sequence" if undo else "sequence"
        ).values_list("changes", flat=True)
        for changes in batches.iterator(chunk_size=64):
            if undo:
                for change in reversed(changes):
                    apply_change(change["after"], change["before"])
            else:
                for change in changes:
                    apply_change(change["before"], change["after"])
        _move_cursor(db, journal, target)


def _entry_payload(sequence, label, created):
    return {"sequence": sequence, "label": label, "timestamp": created.isoformat()}


def history_payload(journal):
    """Return metadata from a journal already locked by the caller."""
    entries = journal.entries.using(journal._state.db).order_by("sequence").values_list("sequence", "label", "created")
    return {
        "cursor": journal.cursor,
        "revision": journal.revision,
        "entries": [_entry_payload(*entry) for entry in entries],
    }


def history_for_rack(user, rack_id):
    """Read a consistent metadata snapshot without creating or locking a journal."""
    payload = {"cursor": 0, "revision": 0, "entries": []}
    if not user.is_authenticated:
        return payload
    # Use the same database as mutations. The join reads the cursor, revision and
    # entries in a single statement, so a concurrent edit cannot split the snapshot.
    rows = CableHistoryJournal.objects.using(router.db_for_write(Cable)).filter(
        rack_id=rack_id, user_id=user.pk,
    ).order_by("entries__sequence").values_list(
        "cursor", "revision", "entries__sequence", "entries__label", "entries__created",
    )
    for cursor, revision, sequence, label, created in rows.iterator(chunk_size=64):
        payload["cursor"] = cursor
        payload["revision"] = revision
        if sequence is not None:
            payload["entries"].append(_entry_payload(sequence, label, created))
    return payload
