from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from threading import Barrier
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import connections, router, transaction
from django.test import TransactionTestCase
from django.urls import reverse

from dcim.choices import CableProfileChoices, CableTypeChoices, InterfaceTypeChoices, LinkStatusChoices, PortTypeChoices
from dcim.models import Cable, Device, DeviceRole, DeviceType, FrontPort, Interface, Manufacturer, PortMapping, Rack, RearPort, Site
from utilities.testing import TestCase

from nbcableeditor.cable_history import history_for_rack
from nbcableeditor.cable_views import CableEditError, _save_cable, port_key
from nbcableeditor.plan_apply import apply_rack_plan


def _rack_fixture():
    site = Site.objects.create(name="Planning site", slug="planning-site")
    manufacturer = Manufacturer.objects.create(name="Planning vendor", slug="planning-vendor")
    device_type = DeviceType.objects.create(manufacturer=manufacturer, model="Planning switch", slug="planning-switch")
    role = DeviceRole.objects.create(name="Planning role", slug="planning-role", color="173a71")
    rack = Rack.objects.create(site=site, name="Planning rack")
    upper, lower = [
        Device.objects.create(device_type=device_type, role=role, site=site, rack=rack, name=name, position=position)
        for name, position in (("Upper", 4), ("Lower", 2))
    ]
    ports = [
        Interface.objects.create(device=device, name=f"Port {number}", type=InterfaceTypeChoices.TYPE_1GE_FIXED)
        for device in (upper, lower) for number in range(1, 4)
    ]
    return rack, ports


class RackPlanGraphTests(TestCase):
    user_permissions = ("dcim.view_rack", "dcim.view_device", "dcim.view_interface", "dcim.view_cable")

    @classmethod
    def setUpTestData(cls):
        cls.rack, cls.ports = _rack_fixture()

    def apply(self, operations, status=LinkStatusChoices.STATUS_PLANNED):
        db = router.db_for_write(Cable)
        user = get_user_model().objects.get(pk=self.user.pk)
        with transaction.atomic(using=db):
            return apply_rack_plan(db, user, self.rack.pk, operations, status=status, label="Apply test plan")

    def history(self, target, revision):
        return self.client.post(
            reverse("plugins:nbcableeditor:cables", args=[self.rack.pk]),
            {"action": "history", "target": target, "revision": revision}, content_type="application/json",
        )

    def endpoints(self):
        return {
            cable.pk: tuple(end.termination_id for end in cable.terminations.order_by("cable_end"))
            for cable in Cable.objects.all()
        }

    def test_port_swap_undo_redo_preserves_native_cable_ids_and_profile(self):
        self.add_permissions("dcim.change_cable")
        a, b, _, x, y, _ = self.ports
        first = Cable.objects.create(a_terminations=[a], b_terminations=[x], label="Retained", color="ff0000")
        second = Cable.objects.create(a_terminations=[b], b_terminations=[y], profile=CableProfileChoices.SINGLE_1C1P)
        original = self.endpoints()
        result = self.apply([
            {"id": "one", "action": "move", "cable_id": first.pk, "before": {"a": a.pk, "b": x.pk}, "a": a.pk, "b": y.pk},
            {"id": "two", "action": "move", "cable_id": second.pk, "before": {"a": b.pk, "b": y.pk}, "a": b.pk, "b": x.pk},
        ])
        target = {first.pk: (a.pk, y.pk), second.pk: (b.pk, x.pk)}
        self.assertEqual(self.endpoints(), target)
        self.assertEqual(result["ids"], {"one": first.pk, "two": second.pk})
        self.assertEqual(len(result["history"]["entries"]), 1)

        response = self.history(0, 1)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.endpoints(), original)
        response = self.history(1, 2)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.endpoints(), target)
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual((first.label, first.color), ("Retained", "ff0000"))
        self.assertEqual(second.profile, CableProfileChoices.SINGLE_1C1P)
        self.assertTrue(all(end.connector == 1 for end in second.terminations.all()))

    def test_delete_and_add_reuse_port_and_history_restores_both_ids(self):
        self.add_permissions("dcim.add_cable", "dcim.delete_cable")
        a, _, _, x, y, _ = self.ports
        old = Cable.objects.create(a_terminations=[a], b_terminations=[x])
        result = self.apply([
            {"id": "remove", "action": "delete", "cable_id": old.pk, "before": {"a": a.pk, "b": x.pk}},
            {
                "id": "new", "action": "add", "a": a.pk, "b": y.pk, "type": CableTypeChoices.TYPE_CAT6,
                "length": "0.75", "length_unit": "m", "label": "New cable",
            },
        ])
        created = Cable.objects.get(pk=result["ids"]["new"])
        self.assertEqual((created.status, created.length, created.length_unit), ("planned", Decimal("0.75"), "m"))
        self.assertEqual(self.endpoints(), {created.pk: (a.pk, y.pk)})
        response = self.history(0, 1)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.endpoints(), {old.pk: (a.pk, x.pk)})
        response = self.history(1, 2)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.endpoints(), {created.pk: (a.pk, y.pk)})

    def test_conflicting_live_cable_and_missing_permissions_are_rejected(self):
        a, b, _, x, y, _ = self.ports
        Cable.objects.create(a_terminations=[a], b_terminations=[x])
        operation = {"id": "new", "action": "add", "a": b.pk, "b": x.pk}
        with self.assertRaises(CableEditError) as denied:
            self.apply([operation])
        self.assertEqual(denied.exception.status, 403)
        self.add_permissions("dcim.add_cable")
        with self.assertRaises(CableEditError) as occupied:
            self.apply([operation])
        self.assertEqual(occupied.exception.status, 409)
        self.assertEqual(Cable.objects.count(), 1)
        self.assertEqual(history_for_rack(self.user, self.rack.pk)["cursor"], 0)
        result = self.apply([{**operation, "b": y.pk}], status=LinkStatusChoices.STATUS_CONNECTED)
        self.assertEqual(Cable.objects.get(pk=result["ids"]["new"]).status, "connected")

    def test_moving_patch_panel_lead_rebuilds_and_undo_restores_the_trace(self):
        self.add_permissions("dcim.view_frontport", "dcim.view_rearport", "dcim.change_cable")
        a, _, _, x, _, _ = self.ports
        front = FrontPort.objects.create(device=x.device, name="Front", type=PortTypeChoices.TYPE_8P8C)
        rear = RearPort.objects.create(device=x.device, name="Rear", type=PortTypeChoices.TYPE_8P8C)
        spare = RearPort.objects.create(device=x.device, name="Spare", type=PortTypeChoices.TYPE_8P8C)
        PortMapping.objects.create(device=x.device, front_port=front, rear_port=rear)
        Cable.objects.create(a_terminations=[rear], b_terminations=[x])
        lead = Cable.objects.create(a_terminations=[a], b_terminations=[front])
        a.refresh_from_db()
        self.assertTrue(a.path.is_complete)

        self.apply([{
            "id": "move", "action": "move", "cable_id": lead.pk, "a": a.pk, "b": port_key(RearPort, spare.pk),
            "before": {"a": a.pk, "b": port_key(FrontPort, front.pk)},
        }])
        a.refresh_from_db()
        self.assertFalse(a.path.is_complete)
        undone = self.history(0, 1)
        self.assertEqual(undone.status_code, 200, undone.content)
        a.refresh_from_db()
        self.assertTrue(a.path.is_complete)

    def test_stale_endpoint_snapshot_prevents_overwriting_live_changes(self):
        self.add_permissions("dcim.change_cable")
        a, _, _, x, y, z = self.ports
        cable = Cable.objects.create(a_terminations=[a], b_terminations=[y])
        with self.assertRaisesMessage(CableEditError, "changed after planning"):
            self.apply([{
                "id": "move", "action": "move", "cable_id": cable.pk,
                "before": {"a": a.pk, "b": x.pk}, "a": a.pk, "b": z.pk,
            }])
        self.assertEqual(self.endpoints(), {cable.pk: (a.pk, y.pk)})

    def test_late_error_rolls_back_released_ports_created_cables_and_history(self):
        self.add_permissions("dcim.add_cable", "dcim.change_cable")
        a, b, _, x, y, z = self.ports
        cable = Cable.objects.create(a_terminations=[a], b_terminations=[x])

        def save_with_error(db, candidate, *args, **kwargs):
            if candidate.pk == cable.pk:
                raise ValidationError("Injected failure")
            return _save_cable(db, candidate, *args, **kwargs)

        with patch("nbcableeditor.plan_apply._save_cable", side_effect=save_with_error), self.assertRaises(ValidationError):
            self.apply([
                {"id": "new", "action": "add", "a": b.pk, "b": y.pk},
                {"id": "move", "action": "move", "cable_id": cable.pk, "before": {"a": a.pk, "b": x.pk}, "a": a.pk, "b": z.pk},
            ])
        self.assertEqual(self.endpoints(), {cable.pk: (a.pk, x.pk)})
        self.assertEqual(history_for_rack(self.user, self.rack.pk)["entries"], [])
        x.refresh_from_db()
        self.assertEqual(x.cable_id, cable.pk)


class ConcurrentRackPlanGraphTests(TransactionTestCase):
    def test_different_users_cannot_connect_the_same_port_concurrently(self):
        rack, ports = _rack_fixture()
        a, b, _, x, _, _ = ports
        users = [get_user_model().objects.create(username=f"planner-{i}", is_superuser=True) for i in range(2)]
        barrier = Barrier(len(users))
        db = router.db_for_write(Cable)

        def connect(user, source):
            try:
                with transaction.atomic(using=db):
                    barrier.wait(timeout=10)
                    apply_rack_plan(
                        db, user, rack.pk, [{"id": "new", "action": "add", "a": source, "b": x.pk}],
                        status=LinkStatusChoices.STATUS_PLANNED, label="Apply concurrent plan",
                    )
                return 200
            except CableEditError as error:
                return error.status
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as workers:
            responses = [workers.submit(connect, user, source) for user, source in zip(users, (a.pk, b.pk))]
            self.assertEqual(sorted(response.result(timeout=30) for response in responses), [200, 409])
        self.assertEqual(Cable.objects.count(), 1)
        self.assertEqual(sorted(history_for_rack(user, rack.pk)["cursor"] for user in users), [0, 1])
