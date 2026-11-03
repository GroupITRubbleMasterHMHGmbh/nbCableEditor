from decimal import Decimal

from django.test import Client
from django.urls import reverse

from core.choices import ObjectChangeActionChoices
from core.models import ObjectChange, ObjectType
from dcim.choices import CableProfileChoices, CableTypeChoices, InterfaceTypeChoices, LinkStatusChoices, PortTypeChoices
from dcim.models import Cable, Device, DeviceRole, DeviceType, FrontPort, Interface, Manufacturer, PortMapping, Rack, RearPort, Site
from extras.choices import CustomFieldTypeChoices
from extras.models import CustomField, JournalEntry, Tag
from tenancy.models import Tenant
from users.models import ObjectPermission, Owner
from utilities.testing import TestCase

from netbox_rack_editor.cable_history import history_for_rack
from netbox_rack_editor.cable_views import port_key
from netbox_rack_editor.models import CableHistoryEntry


class CableEditorTestCase(TestCase):
    user_permissions = ("dcim.view_rack", "dcim.view_device", "dcim.view_interface", "dcim.view_cable")

    @classmethod
    def setUpTestData(cls):
        site = Site.objects.create(name="Test Site", slug="test-site")
        manufacturer = Manufacturer.objects.create(name="Test Manufacturer", slug="test-manufacturer")
        device_type = DeviceType.objects.create(manufacturer=manufacturer, model="Test Switch", slug="test-switch")
        role = DeviceRole.objects.create(name="Test Role", slug="test-role", color="ff0000")
        cls.rack = Rack.objects.create(site=site, name="Primary Rack")
        cls.other_rack = Rack.objects.create(site=site, name="Secondary Rack")
        cls.first, cls.second, cls.external = [
            Device.objects.create(device_type=device_type, role=role, site=site, rack=rack, name=name)
            for rack, name in ((cls.rack, "First"), (cls.rack, "Second"), (cls.other_rack, "External"))
        ]
        cls.a, cls.b, cls.replacement, cls.external_port = [
            Interface.objects.create(device=device, name=name, type=InterfaceTypeChoices.TYPE_1GE_FIXED)
            for device, name in (
                (cls.first, "eth1"),
                (cls.second, "eth1"),
                (cls.second, "eth2"),
                (cls.external, "eth1"),
            )
        ]

    def post(self, payload):
        return self.client.post(
            reverse("plugins:netbox_rack_editor:cables", args=[self.rack.pk]),
            payload, content_type="application/json",
        )

    def edit(self, source, target, cable_id=None, **details):
        return self.post({
            "source": port_key(type(source), source.pk), "target": port_key(type(target), target.pk),
            "cable_id": cable_id, **details,
        })

    def delete(self, cable_id):
        return self.post({"action": "delete", "cable_id": cable_id})

    def update_details(self, cable_id, **details):
        return self.post({"action": "update", "cable_id": cable_id, **details})

    def jump(self, target, revision):
        return self.post({"action": "history", "target": target, "revision": revision})

    def test_create_then_move_cable(self):
        self.add_permissions("dcim.add_cable", "dcim.change_cable")
        created = self.edit(
            self.a, self.b, type=CableTypeChoices.TYPE_CAT6A, color="#1E3AFF", label="Rack patch 01"
        )
        self.assertEqual(created.status_code, 201, created.content)
        cable = Cable.objects.get(pk=created.json()["id"])
        self.assertEqual(cable.a_terminations, [self.a])
        self.assertEqual(cable.b_terminations, [self.b])
        self.assertEqual(cable.type, CableTypeChoices.TYPE_CAT6A)
        self.assertEqual(cable.color, "1e3aff")
        self.assertEqual(cable.label, "Rack patch 01")
        self.a.refresh_from_db()
        self.assertEqual(self.a.link_peers, [self.b])

        # The standard NetBox profile also survives a move.
        cable.profile = CableProfileChoices.SINGLE_1C1P
        cable.save()
        moved = self.edit(self.b, self.replacement, cable.pk, type="usb", color="ff0000", label="Ignored")
        self.assertEqual(moved.status_code, 200, moved.content)
        self.assertEqual(moved.json()["id"], cable.pk)
        cable = Cable.objects.get(pk=cable.pk)
        self.assertEqual(cable.a_terminations, [self.a])
        self.assertEqual(cable.b_terminations, [self.replacement])
        self.assertEqual(cable.label, "Rack patch 01")
        self.assertEqual(cable.color, "1e3aff")
        self.assertEqual(cable.type, CableTypeChoices.TYPE_CAT6A)
        self.assertEqual(cable.profile, CableProfileChoices.SINGLE_1C1P)
        self.b.refresh_from_db()
        self.replacement.refresh_from_db()
        self.assertIsNone(self.b.cable_id)
        self.assertEqual(self.replacement.cable_id, cable.pk)
        self.assertEqual(self.replacement.link_peers, [self.a])
        change = ObjectChange.objects.get(
            changed_object_type=ObjectType.objects.get_for_model(Cable),
            changed_object_id=cable.pk,
            request_id=moved["X-Request-ID"],
            action=ObjectChangeActionChoices.ACTION_UPDATE,
        )
        self.assertNotEqual(change.prechange_data["b_terminations"], change.postchange_data["b_terminations"])

    def test_passive_port_mutations_and_history_rebuild_native_paths(self):
        self.add_permissions(
            "dcim.view_frontport", "dcim.view_rearport", "dcim.add_cable", "dcim.change_cable", "dcim.delete_cable",
        )
        front = FrontPort.objects.create(device=self.second, name="Panel Front", type=PortTypeChoices.TYPE_8P8C)
        rear = RearPort.objects.create(device=self.second, name="Panel Rear", type=PortTypeChoices.TYPE_8P8C)
        alternate = RearPort.objects.create(device=self.first, name="Spare Rear", type=PortTypeChoices.TYPE_8P8C)
        PortMapping.objects.create(device=self.second, front_port=front, rear_port=rear)
        downstream = Cable.objects.create(a_terminations=[rear], b_terminations=[self.b])

        created = self.edit(self.a, front, label="Panel lead")
        self.assertEqual(created.status_code, 201, created.content)
        cable_id = created.json()["id"]
        entry = CableHistoryEntry.objects.get(journal__rack=self.rack, sequence=1)
        self.assertEqual(entry.changes[0]["after"]["ends"]["A"]["port"], self.a.pk)
        self.assertEqual(entry.changes[0]["after"]["ends"]["B"]["port"], f"front-port:{front.pk}")

        def assert_path(endpoint, complete):
            cable = Cable.objects.get(pk=cable_id)
            self.assertEqual(cable.a_terminations, [self.a])
            self.assertEqual(cable.b_terminations, [endpoint])
            self.assertEqual(cable.label, "Panel lead")
            self.a.refresh_from_db()
            self.assertEqual(self.a.cable_id, cable_id)
            self.assertEqual(self.a.path.is_complete, complete)
            self.assertEqual(Cable.objects.get(pk=downstream.pk).b_terminations, [self.b])

        assert_path(front, True)
        moved = self.edit(front, alternate, cable_id)
        self.assertEqual(moved.status_code, 200, moved.content)
        assert_path(alternate, False)
        front.refresh_from_db()
        self.assertIsNone(front.cable_id)

        undone = self.jump(1, moved.json()["history"]["revision"])
        self.assertEqual(undone.status_code, 200, undone.content)
        assert_path(front, True)
        redone = self.jump(2, undone.json()["history"]["revision"])
        self.assertEqual(redone.status_code, 200, redone.content)
        assert_path(alternate, False)

        deleted = self.delete(cable_id)
        self.assertEqual(deleted.status_code, 200, deleted.content)
        alternate.refresh_from_db()
        self.assertIsNone(alternate.cable_id)
        restored = self.jump(2, deleted.json()["history"]["revision"])
        self.assertEqual(restored.status_code, 200, restored.content)
        assert_path(alternate, False)

        initial = self.jump(0, restored.json()["history"]["revision"])
        self.assertEqual(initial.status_code, 200, initial.content)
        self.assertFalse(Cable.objects.filter(pk=cable_id).exists())
        self.a.refresh_from_db()
        self.assertIsNone(self.a.cable_id)
        self.assertEqual(Cable.objects.get(pk=downstream.pk).a_terminations, [rear])

    def test_passive_port_keys_are_typed_even_when_model_ids_overlap(self):
        self.add_permissions("dcim.view_frontport", "dcim.view_rearport", "dcim.add_cable")
        common_pk = 900_000
        front = FrontPort.objects.create(pk=common_pk, device=self.first, name="Front", type=PortTypeChoices.TYPE_8P8C)
        rear = RearPort.objects.create(pk=common_pk, device=self.second, name="Rear", type=PortTypeChoices.TYPE_8P8C)
        interface = Interface.objects.create(
            pk=common_pk, device=self.first, name="same-id", type=InterfaceTypeChoices.TYPE_1GE_FIXED,
        )
        for key in (str(common_pk), f"interface:{common_pk}", f"front-port:0{common_pk}", "rear-port:9223372036854775808"):
            with self.subTest(key=key):
                self.assertEqual(self.post({"source": key, "target": self.a.pk}).status_code, 400)
        self.assertEqual(self.edit(front, front).status_code, 400)

        response = self.edit(front, rear)
        self.assertEqual(response.status_code, 201, response.content)
        cable = Cable.objects.get(pk=response.json()["id"])
        self.assertEqual(cable.a_terminations, [front])
        self.assertEqual(cable.b_terminations, [rear])
        interface.refresh_from_db()
        self.assertIsNone(interface.cable_id)
        self.assertEqual(self.edit(front, interface).status_code, 409)
        # A termination on a passive port with this PK cannot occupy a numeric interface key.
        response = self.edit(interface, self.a)
        self.assertEqual(response.status_code, 201, response.content)

    def test_passive_port_mutations_require_visible_same_rack_ports(self):
        self.add_permissions("dcim.add_cable", "dcim.change_cable", "dcim.delete_cable")
        front = FrontPort.objects.create(device=self.second, name="Front", type=PortTypeChoices.TYPE_8P8C)
        marked = RearPort.objects.create(
            device=self.second, name="Marked Rear", type=PortTypeChoices.TYPE_8P8C, mark_connected=True,
        )
        external = RearPort.objects.create(device=self.external, name="Remote Rear", type=PortTypeChoices.TYPE_8P8C)
        self.assertEqual(self.edit(self.a, front).status_code, 404)
        self.add_permissions("dcim.view_frontport", "dcim.view_rearport")
        self.assertEqual(self.edit(front, marked).status_code, 409)
        self.assertEqual(self.edit(front, external).status_code, 404)

        cable = Cable.objects.create(a_terminations=[front], b_terminations=[external])
        self.assertEqual(self.edit(front, self.a, cable.pk).status_code, 404)
        self.assertEqual(self.delete(cable.pk).status_code, 404)
        self.assertEqual(self.update_details(cable.pk, label="Outside rack").status_code, 404)
        self.assertEqual(Cable.objects.get(pk=cable.pk).b_terminations, [external])

    def test_create_rejects_invalid_cable_details(self):
        self.add_permissions("dcim.add_cable")
        for details in (
            {"type": "unknown-cable-type"},
            {"color": "#fff"},
            {"color": False},
            {"label": "a" * 101},
            {"label": "patch\x00label"},
        ):
            with self.subTest(details=details):
                response = self.edit(self.a, self.b, **details)
                self.assertEqual(response.status_code, 400, response.content)
        self.assertFalse(Cable.objects.exists())

    def test_update_cable_details_and_replay_preserve_terminations(self):
        self.add_permissions("dcim.change_cable")
        original = {
            "label": "Lab patch", "type": CableTypeChoices.TYPE_CAT6, "color": "202020",
            "status": LinkStatusChoices.STATUS_CONNECTED, "description": "Original description",
        }
        updated = {
            "label": "Planned patch", "type": CableTypeChoices.TYPE_CAT6A, "color": "1e3aff",
            "status": LinkStatusChoices.STATUS_PLANNED, "description": "Replacement description",
        }
        cable = Cable.objects.create(
            a_terminations=[self.a], b_terminations=[self.b],
            profile=CableProfileChoices.SINGLE_1C1P, comments="Preserve this", **original,
        )
        cable_id = cable.pk
        ends = list(cable.terminations.order_by("pk").values_list("pk", "connector", "positions"))

        def assert_state(expected):
            cable.refresh_from_db()
            self.assertEqual(cable.pk, cable_id)
            self.assertEqual(cable.profile, CableProfileChoices.SINGLE_1C1P)
            self.assertEqual(cable.comments, "Preserve this")
            self.assertEqual(cable.a_terminations, [self.a])
            self.assertEqual(cable.b_terminations, [self.b])
            self.assertEqual(list(cable.terminations.order_by("pk").values_list("pk", "connector", "positions")), ends)
            for field, value in expected.items():
                self.assertEqual(getattr(cable, field), value, field)
            self.a.refresh_from_db()
            self.assertEqual(self.a.cable_id, cable.pk)
            self.assertEqual(self.a._path.is_active, expected["status"] == LinkStatusChoices.STATUS_CONNECTED)

        response = self.update_details(cable.pk, **{**updated, "color": "#1E3AFF"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["id"], cable.pk)
        history = response.json()["history"]
        self.assertEqual(history["entries"][0]["label"], f"Updated cable #{cable.pk}")
        assert_state(updated)
        change = ObjectChange.objects.get(
            changed_object_type=ObjectType.objects.get_for_model(Cable), changed_object_id=cable.pk,
            request_id=response["X-Request-ID"], action=ObjectChangeActionChoices.ACTION_UPDATE,
        )
        self.assertEqual(change.prechange_data["label"], original["label"])
        self.assertEqual(change.postchange_data["label"], updated["label"])
        self.assertEqual(change.prechange_data["a_terminations"], change.postchange_data["a_terminations"])
        self.assertEqual(change.prechange_data["b_terminations"], change.postchange_data["b_terminations"])

        undo = self.jump(0, history["revision"])
        self.assertEqual(undo.status_code, 200, undo.content)
        assert_state(original)
        redo = self.jump(1, undo.json()["history"]["revision"])
        self.assertEqual(redo.status_code, 200, redo.content)
        assert_state(updated)

    def test_update_details_validate_and_allow_partial_noop_edits(self):
        self.add_permissions("dcim.change_cable")
        cable = Cable.objects.create(
            a_terminations=[self.a], b_terminations=[self.b],
            type=CableTypeChoices.TYPE_CAT6, label="Original label", color="aabbcc",
        )
        for details in (
            {}, {"status": None}, {"status": "Connected"}, {"type": []}, {"color": "#fff"},
            {"label": "a" * 101}, {"description": "a" * 201}, {"description": "patch\x00description"},
        ):
            with self.subTest(details=details):
                response = self.update_details(cable.pk, **details)
                self.assertEqual(response.status_code, 400, response.content)
        unchanged = self.update_details(cable.pk, color="#AABBCC")
        self.assertEqual(unchanged.status_code, 200, unchanged.content)
        self.assertEqual(unchanged.json()["history"], {"entries": [], "cursor": 0, "revision": 0})
        self.assertFalse(ObjectChange.objects.filter(request_id=unchanged["X-Request-ID"]).exists())

        response = self.update_details(cable.pk, type=None, color="", source=self.a.pk, target=self.replacement.pk)
        self.assertEqual(response.status_code, 200, response.content)
        cable.refresh_from_db()
        self.assertIsNone(cable.type)
        self.assertEqual(cable.color, "")
        self.assertEqual(cable.label, "Original label")
        self.assertEqual(cable.b_terminations, [self.b])
        self.replacement.refresh_from_db()
        self.assertIsNone(self.replacement.cable_id)

    def test_update_details_enforces_rack_and_cable_permissions(self):
        cable = Cable.objects.create(a_terminations=[self.a], b_terminations=[self.b], label="Allowed")
        denied = self.update_details(cable.pk, label="Changed")
        self.assertEqual(denied.status_code, 403, denied.content)

        permission = ObjectPermission.objects.create(
            name="Change specific cable labels only", actions=["change"], constraints={"label": "Allowed"},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(Cable))
        permission.users.add(self.user)
        denied = self.update_details(cable.pk, label="Changed")
        self.assertEqual(denied.status_code, 403, denied.content)
        cable.refresh_from_db()
        self.assertEqual(cable.label, "Allowed")
        self.assertEqual(history_for_rack(self.user, self.rack.pk), {"entries": [], "cursor": 0, "revision": 0})
        external = Cable.objects.create(
            a_terminations=[self.replacement], b_terminations=[self.external_port], label="Allowed",
        )
        denied = self.update_details(external.pk, description="Changed")
        self.assertEqual(denied.status_code, 404, denied.content)
        self.remove_permissions("dcim.view_cable")
        denied = self.update_details(cable.pk, description="Changed")
        self.assertEqual(denied.status_code, 404, denied.content)

    def test_create_rejects_occupied_and_nonphysical_interfaces(self):
        self.add_permissions("dcim.add_cable")
        cable = Cable.objects.create(a_terminations=[self.a], b_terminations=[self.b])
        occupied = self.edit(self.replacement, self.a)
        self.assertEqual(occupied.status_code, 409, occupied.content)
        self.assertEqual(Cable.objects.count(), 1)
        self.assertEqual(cable.a_terminations, [self.a])

        virtual = Interface.objects.create(device=self.first, name="virtual0", type=InterfaceTypeChoices.TYPE_VIRTUAL)
        marked = Interface.objects.create(
            device=self.first, name="eth2", type=InterfaceTypeChoices.TYPE_1GE_FIXED, mark_connected=True,
        )
        for port in (virtual, marked):
            with self.subTest(port=port):
                unavailable = self.edit(self.replacement, port)
                self.assertEqual(unavailable.status_code, 409, unavailable.content)

    def test_move_and_delete_reject_external_and_complex_cables(self):
        self.add_permissions("dcim.change_cable", "dcim.delete_cable")
        external = Cable.objects.create(a_terminations=[self.a], b_terminations=[self.external_port])
        response = self.edit(self.a, self.replacement, external.pk)
        self.assertEqual(response.status_code, 404, response.content)
        response = self.delete(external.pk)
        self.assertEqual(response.status_code, 404, response.content)

        extra = Interface.objects.create(device=self.first, name="eth2", type=InterfaceTypeChoices.TYPE_1GE_FIXED)
        complex_cable = Cable.objects.create(a_terminations=[extra], b_terminations=[self.b, self.replacement])
        response = self.edit(self.b, self.a, complex_cable.pk)
        self.assertEqual(response.status_code, 409, response.content)
        response = self.delete(complex_cable.pk)
        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(Cable.objects.count(), 2)

    def test_delete_releases_both_ports_and_logs_the_cable(self):
        self.add_permissions("dcim.add_cable", "dcim.delete_cable")
        cable = Cable.objects.create(a_terminations=[self.a], b_terminations=[self.b], label="Delete me")
        other_cable = Cable.objects.create(a_terminations=[self.replacement], b_terminations=[self.external_port])
        response = self.delete(cable.pk)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["id"], cable.pk)
        self.assertEqual(list(Cable.objects.values_list("pk", flat=True)), [other_cable.pk])
        for port in (self.a, self.b):
            port.refresh_from_db()
            self.assertIsNone(port.cable_id)
            self.assertIsNone(port._path_id)
        self.replacement.refresh_from_db()
        self.assertEqual(self.replacement.cable_id, other_cable.pk)
        change = ObjectChange.objects.get(
            changed_object_type=ObjectType.objects.get_for_model(Cable),
            changed_object_id=cable.pk,
            request_id=response["X-Request-ID"],
            action=ObjectChangeActionChoices.ACTION_DELETE,
        )
        self.assertEqual(change.prechange_data["label"], "Delete me")
        recreated = self.edit(self.a, self.b, type="")
        self.assertEqual(recreated.status_code, 201, recreated.content)
        self.assertIsNone(Cable.objects.get(pk=recreated.json()["id"]).type)

    def test_delete_enforces_native_object_permissions(self):
        cable = Cable.objects.create(a_terminations=[self.a], b_terminations=[self.b], label="Protected cable")
        denied = self.delete(cable.pk)
        self.assertEqual(denied.status_code, 403, denied.content)

        permission = ObjectPermission.objects.create(
            name="Delete specific cable labels only", actions=["delete"], constraints={"label": "Allowed"}
        )
        permission.object_types.add(ObjectType.objects.get_for_model(Cable))
        permission.users.add(self.user)
        denied = self.delete(cable.pk)
        self.assertEqual(denied.status_code, 404, denied.content)

        cable.label = "Allowed"
        cable.save()
        self.remove_permissions("dcim.view_cable")
        denied = self.delete(cable.pk)
        self.assertEqual(denied.status_code, 404, denied.content)
        self.assertTrue(Cable.objects.filter(pk=cable.pk).exists())

    def test_create_enforces_resulting_cable_permissions_and_rolls_back(self):
        permission = ObjectPermission.objects.create(
            name="Other rack cables only",
            actions=["add"],
            constraints={"terminations___rack_id": self.other_rack.pk},
        )
        permission.object_types.add(ObjectType.objects.get_for_model(Cable))
        permission.users.add(self.user)

        response = self.edit(self.a, self.b)
        self.assertEqual(response.status_code, 403, response.content)
        self.assertFalse(Cable.objects.exists())
        self.a.refresh_from_db()
        self.b.refresh_from_db()
        self.assertIsNone(self.a.cable_id)
        self.assertIsNone(self.b.cable_id)

    def test_create_and_delete_require_visible_interfaces_and_devices(self):
        self.add_permissions("dcim.add_cable", "dcim.delete_cable")
        self.remove_permissions("dcim.view_device")
        permission = ObjectPermission.objects.create(
            name="First device only", actions=["view"], constraints={"pk": self.first.pk}
        )
        permission.object_types.add(ObjectType.objects.get_for_model(Device))
        permission.users.add(self.user)

        response = self.edit(self.a, self.b)
        self.assertEqual(response.status_code, 404, response.content)
        self.assertFalse(Cable.objects.exists())

        cable = Cable.objects.create(a_terminations=[self.a], b_terminations=[self.b])
        response = self.delete(cable.pk)
        self.assertEqual(response.status_code, 404, response.content)
        self.assertTrue(Cable.objects.filter(pk=cable.pk).exists())

    def test_batch_reuses_ports_and_replays_as_one_transaction(self):
        self.add_permissions("dcim.add_cable", "dcim.delete_cable")
        original = Cable.objects.create(a_terminations=[self.a], b_terminations=[self.b])
        response = self.post({"action": "batch", "operations": [
            {"action": "delete", "cable_id": original.pk},
            {"source": self.a.pk, "target": self.replacement.pk, "cable_id": None},
        ]})
        self.assertEqual(response.status_code, 200, response.content)
        old_id, new_id = response.json()["ids"]
        history = response.json()["history"]
        self.assertEqual(old_id, original.pk)
        self.assertEqual(history["cursor"], 1)
        self.assertEqual(len(history["entries"]), 1)
        self.assertFalse(Cable.objects.filter(pk=old_id).exists())

        undo = self.jump(0, history["revision"])
        self.assertEqual(undo.status_code, 200, undo.content)
        self.assertEqual(Cable.objects.get(pk=old_id).b_terminations, [self.b])
        self.assertFalse(Cable.objects.filter(pk=new_id).exists())
        redo = self.jump(1, undo.json()["history"]["revision"])
        self.assertEqual(redo.status_code, 200, redo.content)
        self.assertFalse(Cable.objects.filter(pk=old_id).exists())
        self.assertEqual(Cable.objects.get(pk=new_id).b_terminations, [self.replacement])

    def test_failed_batch_rolls_back_native_changes_and_history(self):
        self.add_permissions("dcim.add_cable", "dcim.delete_cable")
        original = Cable.objects.create(a_terminations=[self.a], b_terminations=[self.b])
        operations = [
            {"action": "delete", "cable_id": original.pk},
            {"source": self.a.pk, "target": self.replacement.pk},
            {"source": self.b.pk, "target": self.replacement.pk},
        ]
        response = self.post({"action": "batch", "operations": operations})
        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(list(Cable.objects.values_list("pk", flat=True)), [original.pk])
        self.a.refresh_from_db()
        self.replacement.refresh_from_db()
        self.assertEqual(self.a.link_peers, [self.b])
        self.assertIsNone(self.replacement.cable_id)
        self.assertFalse(ObjectChange.objects.filter(request_id=response["X-Request-ID"]).exists())
        self.assertEqual(history_for_rack(self.user, self.rack.pk), {"entries": [], "cursor": 0, "revision": 0})

        oversized = self.post({"action": "batch", "operations": [operations[0]] * 101})
        self.assertEqual(oversized.status_code, 400, oversized.content)

    def test_undo_delete_restores_native_cable_metadata_and_profile(self):
        self.add_permissions("dcim.add_cable", "dcim.delete_cable")
        field = CustomField.objects.create(name="patch_ticket", type=CustomFieldTypeChoices.TYPE_TEXT)
        field.object_types.add(ObjectType.objects.get_for_model(Cable))
        tag = Tag.objects.create(name="Spare patch", slug="spare-patch")
        tenant = Tenant.objects.create(name="Cable Tenant", slug="cable-tenant")
        owner = Owner.objects.create(name="Cable Owner")
        details = {
            "label": "Reserved cable", "type": CableTypeChoices.TYPE_CAT6A,
            "color": "aabbcc", "length": Decimal("3.25"), "length_unit": "m",
            "status": LinkStatusChoices.STATUS_PLANNED, "profile": CableProfileChoices.SINGLE_1C1P,
            "description": "Backup link", "comments": "Keep in this rack", "tenant_id": tenant.pk,
            "owner_id": owner.pk, "custom_field_data": {"patch_ticket": "T-123"},
        }
        cable = Cable.objects.create(a_terminations=[self.a], b_terminations=[self.b], **details)
        cable.tags.add(tag)
        deleted = self.delete(cable.pk)
        self.assertEqual(deleted.status_code, 200, deleted.content)
        self.assertFalse(Cable.objects.filter(pk=cable.pk).exists())

        undo = self.jump(0, deleted.json()["history"]["revision"])
        self.assertEqual(undo.status_code, 200, undo.content)
        restored = Cable.objects.get(pk=cable.pk)
        for name, value in details.items():
            with self.subTest(field=name):
                self.assertEqual(getattr(restored, name), value)
        self.assertEqual(list(restored.tags.all()), [tag])
        self.assertEqual(restored.a_terminations, [self.a])
        self.assertEqual(restored.b_terminations, [self.b])
        self.assertEqual(
            list(restored.terminations.order_by("cable_end").values_list("connector", "positions")),
            [(1, [1]), (1, [1])],
        )
        self.assertTrue(ObjectChange.objects.filter(
            changed_object_type=ObjectType.objects.get_for_model(Cable), changed_object_id=cable.pk,
            action=ObjectChangeActionChoices.ACTION_CREATE, request_id=undo["X-Request-ID"],
        ).exists())

    def test_undo_redo_move_checks_revision(self):
        self.add_permissions("dcim.change_cable")
        cable = Cable.objects.create(a_terminations=[self.a], b_terminations=[self.b], label="Rack patch")
        moved = self.edit(self.b, self.replacement, cable.pk)
        self.assertEqual(moved.status_code, 200, moved.content)
        revision = moved.json()["history"]["revision"]
        undo = self.jump(0, revision)
        self.assertEqual(undo.status_code, 200, undo.content)
        self.assertEqual(Cable.objects.get(pk=cable.pk).b_terminations, [self.b])
        stale = self.jump(1, revision)
        self.assertEqual(stale.status_code, 409, stale.content)
        redo = self.jump(1, undo.json()["history"]["revision"])
        self.assertEqual(redo.status_code, 200, redo.content)
        restored = Cable.objects.get(pk=cable.pk)
        self.assertEqual(restored.b_terminations, [self.replacement])
        self.assertEqual(restored.label, "Rack patch")

    def test_jump_conflict_rolls_back_other_replayed_entries(self):
        self.add_permissions("dcim.add_cable", "dcim.delete_cable")
        extra = Interface.objects.create(device=self.first, name="eth2", type=InterfaceTypeChoices.TYPE_1GE_FIXED)
        first = self.edit(self.a, self.b)
        second = self.edit(extra, self.replacement)
        self.assertEqual(first.status_code, 201, first.content)
        self.assertEqual(second.status_code, 201, second.content)
        first_id, second_id = first.json()["id"], second.json()["id"]
        Cable.objects.filter(pk=first_id).update(label="Native edit")
        history = second.json()["history"]
        response = self.jump(0, history["revision"])
        self.assertEqual(response.status_code, 409, response.content)
        self.assertEqual(Cable.objects.get(pk=first_id).label, "Native edit")
        self.assertTrue(Cable.objects.filter(pk=second_id).exists())
        self.assertFalse(ObjectChange.objects.filter(request_id=response["X-Request-ID"]).exists())
        self.assertEqual(history_for_rack(self.user, self.rack.pk), history)

    def test_undo_creation_requires_delete_permission_and_preserves_linked_records(self):
        self.add_permissions("dcim.add_cable")
        created = self.edit(self.a, self.b)
        self.assertEqual(created.status_code, 201, created.content)
        cable = Cable.objects.get(pk=created.json()["id"])
        history = created.json()["history"]
        unauthorized = self.jump(0, history["revision"])
        self.assertEqual(unauthorized.status_code, 403, unauthorized.content)
        self.add_permissions("dcim.delete_cable")
        note = JournalEntry.objects.create(assigned_object=cable, comments="Native note")
        for response in (self.jump(0, history["revision"]), self.delete(cable.pk)):
            self.assertEqual(response.status_code, 409, response.content)
        self.assertTrue(Cable.objects.filter(pk=cable.pk).exists())
        self.assertTrue(JournalEntry.objects.filter(pk=note.pk).exists())
        self.assertEqual(history_for_rack(self.user, self.rack.pk), history)

    def test_csrf_and_method_required(self):
        self.add_permissions("dcim.add_cable")
        self.client = Client(enforce_csrf_checks=True)
        self.client.force_login(self.user)
        self.assertEqual(self.edit(self.a, self.b).status_code, 403)
        self.assertEqual(self.client.get(reverse("plugins:netbox_rack_editor:cables", args=[self.rack.pk])).status_code, 405)
        self.assertFalse(Cable.objects.exists())
