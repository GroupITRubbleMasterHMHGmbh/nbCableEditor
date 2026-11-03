from datetime import datetime

from django.contrib.auth import get_user_model
from django.db import router, transaction

from dcim.models import Cable, Rack, Site
from utilities.testing import TestCase

from netbox_rack_editor.cable_history import (
    HistoryConflictError,
    history_for_rack,
    history_payload,
    jump_history,
    lock_history,
    record_history,
)
from netbox_rack_editor.models import CableHistoryJournal


class CableHistoryTestCase(TestCase):
    @classmethod
    def setUpTestData(cls):
        site = Site.objects.create(name="Cable history", slug="cable-history")
        cls.rack = Rack.objects.create(name="Journal rack", site=site)
        cls.other_rack = Rack.objects.create(name="Second journal rack", site=site)
        cls.other_user = get_user_model().objects.create(username="other-cable-editor")

    def setUp(self):
        super().setUp()
        self.db = router.db_for_write(Cable)

    def test_undo_reverses_entry_and_delta_order_redo_restores_forward_order(self):
        first = {"id": 1, "target": 12}
        second = {"id": 2, "target": 34}
        moved = {"id": 1, "target": 56}
        initial = [{"before": None, "after": first}, {"before": None, "after": second}]
        change = [{"before": first, "after": moved}]
        calls = []

        with transaction.atomic(using=self.db):
            journal = lock_history(self.db, self.user, self.rack.pk)
            record_history(self.db, journal, initial, "Connect two cables")
            record_history(self.db, journal, change, "Move one cable")
            jump_history(self.db, journal, 0, 2, lambda *args: calls.append(args))
            self.assertEqual(calls, [(moved, first), (second, None), (first, None)])
            self.assertEqual((journal.cursor, journal.revision), (0, 3))

            calls.clear()
            jump_history(self.db, journal, 2, 3, lambda *args: calls.append(args))
            self.assertEqual(calls, [(None, first), (None, second), (first, moved)])
            self.assertEqual((journal.cursor, journal.revision), (2, 4))
            payload = history_payload(journal)

        self.assertEqual(payload, history_for_rack(self.user, self.rack.pk))
        self.assertEqual([entry["sequence"] for entry in payload["entries"]], [1, 2])
        self.assertEqual([entry["label"] for entry in payload["entries"]], ["Connect two cables", "Move one cable"])
        self.assertIsNotNone(datetime.fromisoformat(payload["entries"][0]["timestamp"]).tzinfo)

    def test_new_edit_after_undo_truncates_redo_and_rejects_old_revision(self):
        change = [{"before": None, "after": {"id": 1}}]
        with transaction.atomic(using=self.db):
            journal = lock_history(self.db, self.user, self.rack.pk)
            record_history(self.db, journal, change, "First edit")
            record_history(self.db, journal, change, "Superseded edit")
            jump_history(self.db, journal, 1, 2, lambda *_: None)
            record_history(self.db, journal, change, "Replacement edit")

            with self.assertRaises(HistoryConflictError) as stale:
                jump_history(self.db, journal, 2, 2, lambda *_: self.fail("Unexpected replay"))
            self.assertEqual(stale.exception.status, 409)
            with self.assertRaises(HistoryConflictError) as invalid:
                jump_history(self.db, journal, 3, 4, lambda *_: self.fail("Unexpected replay"))
            self.assertEqual(invalid.exception.status, 400)

            payload = history_payload(journal)
            self.assertEqual((payload["cursor"], payload["revision"]), (2, 4))
            self.assertEqual([entry["label"] for entry in payload["entries"]], ["First edit", "Replacement edit"])

    def test_failed_jump_rolls_back_prior_callback_writes_and_keeps_cursor(self):
        class CallbackFailure(Exception):
            pass

        before = {"name": self.rack.name}
        after = {"name": "Temporary name"}
        change = [{"before": before, "after": after}]
        failing_change = [{"before": after, "after": {"name": "Conflict"}}]

        def apply_change(_expected, target):
            if target["name"] == "Conflict":
                raise CallbackFailure
            Rack.objects.using(self.db).filter(pk=self.rack.pk).update(name=target["name"])

        with transaction.atomic(using=self.db):
            journal = lock_history(self.db, self.user, self.rack.pk)
            record_history(self.db, journal, change, "First edit")
            record_history(self.db, journal, failing_change, "Second edit")
            jump_history(self.db, journal, 0, 2, lambda *_: None)

            with self.assertRaises(CallbackFailure):
                jump_history(self.db, journal, 2, 3, apply_change)

            self.rack.refresh_from_db()
            journal.refresh_from_db()
            self.assertEqual(self.rack.name, before["name"])
            self.assertEqual((journal.cursor, journal.revision), (0, 3))
            self.assertEqual(journal.entries.count(), 2)

    def test_read_isolated_by_user_and_rack_without_creating_rows(self):
        empty = {"cursor": 0, "revision": 0, "entries": []}
        self.assertEqual(history_for_rack(self.user, self.rack.pk), empty)
        self.assertFalse(CableHistoryJournal.objects.exists())

        with transaction.atomic(using=self.db):
            journal = lock_history(self.db, self.user, self.rack.pk)
            record_history(self.db, journal, [{"before": None, "after": {"id": 1}}], "First edit")

        self.assertEqual(history_for_rack(self.other_user, self.rack.pk), empty)
        self.assertEqual(history_for_rack(self.user, self.other_rack.pk), empty)
        self.assertEqual(CableHistoryJournal.objects.count(), 1)
