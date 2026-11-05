import csv
import io
from types import SimpleNamespace

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from nbcableeditor.calculator import (
    STANDARD_PATCH_LENGTHS_MM, calculate_report, normalize_measurements, normalize_profile, report_csv,
)


def device(device_id, position, x, y=.5, *, height=1, face="front", port_face="front", full_depth=True):
    return {
        "id": device_id, "name": f"Device {device_id}", "position": position, "height": height,
        "face": face, "fullDepth": full_depth,
        "ports": [{"id": device_id, "name": "Port 1", "x": x, "y": y, "face": port_face}],
    }


def cable(cable_id=1, **fields):
    return {"id": cable_id, "a": 1, "b": 2, "typeValue": "cat6", "lengthValue": "1", "lengthUnit": "m", **fields}


class CableCalculatorTests(SimpleTestCase):
    rack = SimpleNamespace(width=19, mounting_depth=None)
    catalog = {"cat6": STANDARD_PATCH_LENGTHS_MM}

    def report(self, devices, *, cables=None, measurements=None, profile=None, **rack_fields):
        data = {"height": 12, "startingUnit": 1, "descUnits": False, "devices": devices, **rack_fields}
        return calculate_report(
            self.rack, data, [cable()] if cables is None else cables, profile or {}, self.catalog, measurements,
        )

    def test_reference_and_right_channel(self):
        devices = [device(1, 9, .2), device(2, 5, .3)]
        left = self.report(devices)["details"][0]
        self.assertEqual((left["route"], left["minimumMm"], left["recommendedMm"]), ("left", 906, 1000))
        self.assertEqual((left["pathMm"], left["connectorMm"], left["bendMm"]), (519.1, 80, 188.5))
        right = self.report(devices, profile={"channels": "right"})["details"][0]
        self.assertEqual((right["route"], right["minimumMm"], right["recommendedMm"]), ("right", 1461, 1500))

    def test_direct_and_half_unit_numbering_both_ways(self):
        row = self.report([device(1, 9, .2), device(2, 8, .2)])["details"][0]
        self.assertEqual((row["route"], row["minimumMm"], row["recommendedMm"]), ("direct", 252, 300))
        devices = [device(1, 3, .2, .1, height=.5), device(2, 3.5, .2, .9, height=.5)]
        for desc, expected in ((False, 206), (True, 247)):
            with self.subTest(desc=desc):
                row = self.report(devices, startingUnit=3, descUnits=desc)["details"][0]
                self.assertEqual((row["route"], row["minimumMm"]), ("direct", expected))

    def test_gap_and_intervening_equipment_are_independent(self):
        devices = [device(1, 9, .2), device(2, 7, .2)]
        self.assertEqual(self.report(devices)["details"][0]["route"], "left")
        gap = {"allow_direct_gap": True, "direct_gap_max_u": .5}
        self.assertEqual(self.report(devices, profile=gap)["details"][0]["route"], "left")
        gap["direct_gap_max_u"] = 1
        self.assertEqual(self.report(devices, profile=gap)["details"][0]["route"], "direct")
        devices.append(device(3, 8, .2))
        self.assertEqual(self.report(devices, profile=gap)["details"][0]["route"], "left")
        self.assertEqual(
            self.report(devices, profile={"allow_direct_intervening": True})["details"][0]["route"], "direct",
        )

    def test_rear_mirror_crossing_depth_and_unmounted(self):
        devices = [device(1, 9, .2), device(2, 8, .8, port_face="rear")]
        row = self.report(devices)["details"][0]
        self.assertIsNone(row["minimumMm"])
        self.assertIn("rail depth", " ".join(row["warnings"]))
        row = self.report(devices, measurements={"mounting_depth_mm": 600})["details"][0]
        self.assertEqual((row["route"], row["pathMm"], row["minimumMm"]), ("left", 953.0, 1459))
        self.assertEqual(row["routeSegments"][2], {"label": "Between rack faces", "lengthMm": 600})
        rear_mounted = device(2, 8, .8, face="rear", full_depth=False)
        self.assertEqual(self.report([devices[0], rear_mounted], measurements={"mounting_depth_mm": 600})["details"][0], row)
        row = self.report([devices[0], device(2, None, .8)])["details"][0]
        self.assertIsNone(row["minimumMm"])
        self.assertIn("No rack mounting position", " ".join(row["warnings"]))
        recessed = device(2, 8, .8, port_face="rear", full_depth=False)
        row = self.report([devices[0], recessed], measurements={"mounting_depth_mm": 600})["details"][0]
        self.assertIsNone(row["minimumMm"])
        self.assertIn("half-depth device", " ".join(row["warnings"]))

    def test_missing_coordinates_use_conservative_footprint(self):
        a = device(1, 9, .2)
        b = device(2, 5, None)
        estimated = self.report([a, b])["details"][0]
        self.assertTrue(estimated["estimated"])
        self.assertEqual(estimated["status"], "too-short")
        self.assertIn("Device 2 / Port 1", " ".join(estimated["warnings"]))
        for x, y in ((0, 0), (0, 1), (1, 0), (1, 1)):
            exact = self.report([a, device(2, 5, x, y)], profile={"channels": estimated["route"]})["details"][0]
            self.assertGreaterEqual(estimated["minimumMm"], exact["minimumMm"])

    def test_channels_balance_and_preference_are_distinct(self):
        profile = {"strategy": "always_channel", "channel_selection": "balanced"}
        rows = self.report([device(1, 9, .5), device(2, 5, .5)], cables=[cable(), cable(2)], profile=profile)["details"]
        self.assertEqual([row["route"] for row in rows], ["left", "right"])
        devices = [device(1, 9, .05), device(2, 8, .05)]
        for strategy, extra, expected in (("prefer_channel", 0, "direct"), ("prefer_channel", 400, "left"),
                                          ("always_channel", 0, "left")):
            with self.subTest(strategy=strategy, extra=extra):
                row = self.report(devices, profile={"strategy": strategy, "channel_preference_mm": extra})["details"][0]
                self.assertEqual(row["route"], expected)

    def test_procurement_excludes_moves_and_csv_preserves_report(self):
        devices = [device(1, 9, .2), device(2, 5, .3)]
        report = self.report(devices, cables=[
            cable(action="new", label="=potential spreadsheet formula", manualLengthMm=900, lengthValue=None),
            cable(2, action="move", lengthValue="2", lengthUnit="ft"),
            cable(3, action="move", lengthValue=None),
        ])
        self.assertEqual(report["billOfMaterials"], [{"type": "cat6", "typeLabel": "CAT6", "lengthMm": 1000, "quantity": 1}])
        self.assertEqual([row["status"] for row in report["details"]], ["too-short", "too-short", "review"])
        self.assertEqual(report["details"][1]["recordedMm"], 609.6)
        self.assertEqual([row["id"] for row in report["billOfMaterialsReview"]], [1])
        raw = report_csv(report, "details")
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
        rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig")), delimiter=";"))
        self.assertEqual([row["Minimum (mm)"] for row in rows], ["906"] * 3)
        self.assertEqual(rows[1]["NetBox length (mm)"], "609,6")
        self.assertEqual(rows[0]["Label"], "'=potential spreadsheet formula")
        self.assertIn("CAT6;1000;1", report_csv(report, "bom").decode("utf-8-sig"))

    def test_stock_deduplicates_trace_segments_and_flags_special_cases(self):
        outside = cable(3, a=None, b=None, endpointA={"deviceName": "Outlet", "portName": "Front"})
        trace = {"segments": [cable(2), outside]}
        report = self.report([device(1, 9, .2), device(2, 5, .3)], cables=[
            cable(traceA=trace, traceB=trace, lengthValue="2"), cable(2, simple=False),
        ])
        first, second, third = report["details"]
        self.assertEqual((first["id"], second["id"], third["id"]), (1, 2, 3))
        self.assertEqual(first["status"], "potentially-shorter")
        self.assertIsNone(second["minimumMm"])
        self.assertIn("multiple terminations", " ".join(second["warnings"]))
        self.assertIsNone(third["minimumMm"])
        self.assertEqual(third["endpointA"]["deviceName"], "Outlet")

    def test_configuration_rejects_invalid_inputs(self):
        self.assertEqual(normalize_measurements({"panel_width_mm": 482.6, "left_channel_offset_mm": 0}),
                         {"panel_width_mm": 482.6, "left_channel_offset_mm": 0})
        for measurements in ({"panel_width_mm": 0}, {"mounting_depth_mm": "600"}, {"wrong": 100}):
            with self.assertRaises(ValidationError):
                normalize_measurements(measurements)
        for profile in ({"reserve_percent": -1}, {"channels": "middle"}, {"bend_radius_mm": {"cat6": "30"}}):
            with self.assertRaises(ValidationError):
                normalize_profile(profile, strict=True)
