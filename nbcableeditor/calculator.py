"""Physical rack cable sizing, recommendations and exports."""

import csv
import io
import math
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from dcim.choices import RackFormFactorChoices
from dcim.models import Cable
from django.core.exceptions import ValidationError
from django.utils.translation import override

from .models import CableEditorSettings


UNIT_MM = 44.45
DEFAULT_PROFILE_NAME = "CAT patch cables"
STANDARD_PATCH_LENGTHS_MM = (250, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000)
ROUTING_STRATEGIES = (
    ("prefer_direct", "Prefer direct"), ("prefer_channel", "Prefer side channel"),
    ("always_channel", "Always use a side channel"),
)
CHANNELS = (("both", "Both"), ("left", "Left only"), ("right", "Right only"))
CHANNEL_SELECTIONS = (
    ("shortest", "Shortest route"), ("left", "Prefer left"), ("right", "Prefer right"),
    ("balanced", "Distribute across both sides"),
)
ROUTE_LABELS = {"direct": "Direct", "left": "Left side channel", "right": "Right side channel"}
NUMBER_SETTINGS = {
    "reserve_percent": (15, 0, 100),
    "connector_lead_mm": (40, 0, 1000),
    "left_channel_offset_mm": (50, 0, 2000),
    "right_channel_offset_mm": (50, 0, 2000),
    "direct_max_mm": (600, 1, 10000),
    "direct_gap_max_u": (1, 0, 100),
    "direct_intervening_max_devices": (1, 0, 100),
    "channel_preference_mm": (150, 0, 2000),
    "balance_tolerance_mm": (100, 0, 2000),
}
BOOLEAN_SETTINGS = ("allow_direct_gap", "allow_direct_intervening")
CHOICE_SETTINGS = {
    "strategy": ROUTING_STRATEGIES, "channels": CHANNELS, "channel_selection": CHANNEL_SELECTIONS,
}
MEASUREMENT_LIMITS = {
    "panel_width_mm": (1, 3000), "mounting_depth_mm": (1, 5000),
    "left_channel_offset_mm": (0, 2000), "right_channel_offset_mm": (0, 2000),
}
LENGTH_FACTORS = {
    "km": 1_000_000, "m": 1000, "cm": 10, "mi": Decimal("1609344"),
    "ft": Decimal("304.8"), "in": Decimal("25.4"),
}


@override("en")
def cable_types():
    return {value: str(label) for value, label in Cable._meta.get_field("type").flatchoices if value}


def _valid_number(value, low, high):
    return type(value) in (int, float) and low <= value <= high


def normalize_profile(raw, strict=False):
    if not isinstance(raw, dict):
        if strict:
            raise ValidationError("Provide an object for the routing profile.")
        raw = {}
    if strict and raw.keys() - {*NUMBER_SETTINGS, *BOOLEAN_SETTINGS, *CHOICE_SETTINGS, "bend_radius_mm"}:
        raise ValidationError("The routing profile contains unknown settings.")

    def choose(key, fallback, valid):
        value = raw.get(key, fallback)
        if valid(value):
            return value
        if strict:
            raise ValidationError(f"Invalid routing profile value for {key.replace('_', ' ')}.")
        return fallback

    profile = {}
    for key, (default, low, high) in NUMBER_SETTINGS.items():
        profile[key] = choose(key, default, lambda value: (
            _valid_number(value, low, high) and (key != "direct_intervening_max_devices" or value % 1 == 0)
        ))
    for key in BOOLEAN_SETTINGS:
        profile[key] = choose(key, False, lambda value: type(value) is bool)
    for key, choices in CHOICE_SETTINGS.items():
        values = tuple(value for value, _ in choices)
        profile[key] = choose(key, values[0], lambda value: value in values)
    radii = choose("bend_radius_mm", {}, lambda value: isinstance(value, dict))
    valid_types = {"default", *cable_types()}
    profile["bend_radius_mm"] = {"default": 30}
    for key, radius in radii.items():
        if key in valid_types and _valid_number(radius, 0, 500):
            profile["bend_radius_mm"][key] = radius
        elif strict:
            raise ValidationError("Bend radii must use a NetBox cable type or 'default' and be between 0 and 500 mm.")
    return profile


def normalize_measurements(raw):
    if not isinstance(raw, dict) or raw.keys() - MEASUREMENT_LIMITS.keys():
        raise ValidationError("Provide valid rack measurements in millimeters.")
    measurements = {}
    for key, value in raw.items():
        if value is None:
            continue
        low, high = MEASUREMENT_LIMITS[key]
        if not _valid_number(value, low, high):
            raise ValidationError(f"{key.replace('_', ' ').capitalize()} must be between {low} and {high} mm.")
        measurements[key] = value
    return measurements


def _default_catalog():
    return {key: list(STANDARD_PATCH_LENGTHS_MM) for key in cable_types() if key.startswith("cat")}


def configured_calculator(options=None):
    if options is None:
        options = CableEditorSettings.objects.filter(pk=1).values_list("options", flat=True).first() or {}
    stored = options.get("calculator") or {}
    profiles = {name: normalize_profile(profile) for name, profile in (stored.get("profiles") or {}).items()}
    if not profiles:
        profiles = {DEFAULT_PROFILE_NAME: normalize_profile({})}
    default = stored.get("defaultProfile")
    return {
        "profiles": profiles,
        "defaultProfile": default if default in profiles else next(iter(profiles)),
        "catalog": stored.get("catalog", _default_catalog()),
    }


def _mounted_top(rack, device):
    position, height = device.get("position"), device.get("height")
    rack_height = rack["height"]
    if position is None or not height or device.get("face") not in ("front", "rear"):
        return None
    offset = position - rack.get("startingUnit", 1)
    top = offset if rack.get("descUnits") else rack_height - offset - height
    return top if 0 <= top and top + height <= rack_height else None


@dataclass(frozen=True)
class Point:
    device_id: int
    face: str
    x: tuple
    y: tuple


def _point(device, top, port, width):
    face = device["face"]
    if port.get("face") == "rear" and device.get("fullDepth"):
        face = "front" if face == "rear" else "rear"
    x, y = port.get("x"), port.get("y")
    if not _valid_number(x, 0, 1) or not _valid_number(y, 0, 1):
        return Point(device["id"], face, (0, width), (top * UNIT_MM, (top + device["height"]) * UNIT_MM))
    x = (1 - x if face == "rear" else x) * width
    y = (top + y * device["height"]) * UNIT_MM
    return Point(device["id"], face, (x, x), (y, y))


def _span(a, b):
    return max(abs(a[0] - b[1]), abs(a[1] - b[0]))


@dataclass(frozen=True)
class Route:
    kind: str
    path: float
    turns: int
    segments: tuple

    def bends(self, radius):
        return self.turns * math.pi * radius / 2

    def minimum(self, radius, lead, reserve):
        return (self.path + self.bends(radius) + lead) * (1 + reserve / 100)


class RackCalculator:
    def __init__(self, rack, rack_data, profile, measurements):
        self.profile = profile
        self.width = measurements.get("panel_width_mm") or float(rack.width) * 25.4
        native_depth = None if getattr(rack, "form_factor", None) == RackFormFactorChoices.TYPE_2POST else rack.mounting_depth
        self.depth = measurements.get("mounting_depth_mm") or native_depth
        self.left = -measurements.get("left_channel_offset_mm", profile["left_channel_offset_mm"])
        self.right = self.width + measurements.get("right_channel_offset_mm", profile["right_channel_offset_mm"])
        self.channel_load = Counter()
        self.ports = {}
        self.bounds = {}
        for device in rack_data["devices"]:
            top = _mounted_top(rack_data, device)
            if top is not None:
                self.bounds[device["id"]] = (top, top + device["height"], device["face"], device["fullDepth"])
            for port in device["ports"]:
                self.ports[port["id"]] = (device, top, port)

    def endpoint(self, key, remote):
        if (entry := self.ports.get(key)) is None:
            return remote, None, "Endpoint is outside this rack or its placement is unavailable."
        device, top, port = entry
        endpoint = {
            "deviceName": device["name"], "deviceType": device.get("deviceType"), "deviceId": device["id"],
            "portId": key, "portName": port["name"], "portUrl": port.get("url"), "deviceUrl": device.get("url"),
        }
        if top is None:
            return endpoint, None, f"No rack mounting position for {device['name']}."
        if port.get("face") == "rear" and not device.get("fullDepth"):
            return endpoint, None, f"Rear port depth is unknown for half-depth device {device['name']}."
        point = _point(device, top, port, self.width)
        endpoint["face"] = point.face
        endpoint["position"] = device["position"]
        estimate = f"Port position missing for {device['name']} / {port['name']}. Estimated across the device face."
        return endpoint, point, estimate if point.x[0] != point.x[1] else None

    def direct_allowed(self, a, b, distance):
        profile = self.profile
        if a.face != b.face or distance > profile["direct_max_mm"]:
            return False
        if a.device_id == b.device_id:
            return True
        first, second = sorted((self.bounds[a.device_id], self.bounds[b.device_id]))
        start, end = first[1], second[0]
        if end <= start:
            return True
        blockers = sorted(
            (max(start, low), min(end, high))
            for device_id, (low, high, face, full_depth) in self.bounds.items()
            if device_id not in (a.device_id, b.device_id) and low < end and high > start
            and (face == a.face or full_depth)
        )
        if blockers and (
            not profile["allow_direct_intervening"] or len(blockers) > profile["direct_intervening_max_devices"]
        ):
            return False
        covered = start
        gap = 0
        for low, high in blockers:
            gap += max(0, low - covered)
            covered = max(covered, high)
        gap += max(0, end - covered)
        return gap == 0 or (profile["allow_direct_gap"] and gap <= profile["direct_gap_max_u"])

    def route(self, a, b, radius, lead):
        profile = self.profile
        reserve = profile["reserve_percent"]
        vertical = _span(a.y, b.y)
        distance = math.hypot(_span(a.x, b.x), vertical)
        direct = Route("direct", distance, 2, (("Direct span", distance),))
        direct_eligible = profile["strategy"] != "always_channel" and self.direct_allowed(a, b, distance)
        if direct_eligible and profile["strategy"] == "prefer_direct":
            return direct
        cross_face = a.face != b.face
        if cross_face and not self.depth:
            return None
        depth = self.depth if cross_face else 0
        vertical = max(vertical, 2 * radius)
        turns = 5 if cross_face else 4
        routes = {}
        for side, x in (("left", self.left), ("right", self.right)):
            if profile["channels"] not in ("both", side):
                continue
            segments = [
                ("End A to channel", _span(a.x, (x, x))), ("Along channel", vertical),
                ("Between rack faces", depth), ("Channel to end B", _span(b.x, (x, x))),
            ]
            routes[side] = Route(side, sum(length for _, length in segments), turns, tuple(segments))
        selection = profile["channel_selection"]
        shortest = min(routes.values(), key=lambda route: route.minimum(radius, lead, reserve))
        route = routes.get(selection, shortest)
        if selection == "balanced" and len(routes) == 2:
            threshold = shortest.minimum(radius, lead, reserve) + profile["balance_tolerance_mm"]
            route = min(
                (candidate for candidate in routes.values() if candidate.minimum(radius, lead, reserve) <= threshold),
                key=lambda candidate: (self.channel_load[candidate.kind], candidate.minimum(radius, lead, reserve)),
            )
        if direct_eligible and route.minimum(radius, lead, reserve) > (
            direct.minimum(radius, lead, reserve) + profile["channel_preference_mm"]
        ):
            return direct
        self.channel_load[route.kind] += 1
        return route


def _recorded_length(cable):
    if cable.get("recordedMm") is not None:
        return cable["recordedMm"]
    try:
        number = Decimal(cable["lengthValue"]) * LENGTH_FACTORS[cable["lengthUnit"]]
        return float(number) if number.is_finite() and number >= 0 else None
    except (InvalidOperation, KeyError, TypeError):
        return None


def _physical_segments(cables, stock):
    by_id = {cable["id"]: cable for cable in cables}
    if stock:
        for cable in cables:
            for trace in (cable.get("traceA"), cable.get("traceB")):
                for segment in (trace or {}).get("segments", []):
                    by_id.setdefault(segment["id"], segment)
    return by_id.values()


def calculate_report(rack, rack_data, cables, profile, catalog, measurements=None, *, planning=None):
    profile = normalize_profile(profile)
    calculator = RackCalculator(rack, rack_data, profile, measurements or {})
    details = []
    counts = Counter()
    if planning is None:
        planning = any(cable.get("action") for cable in cables)
    types = cable_types()
    for cable in _physical_segments(cables, not planning):
        endpoint_a, a, warning_a = calculator.endpoint(cable.get("a"), cable.get("endpointA"))
        endpoint_b, b, warning_b = calculator.endpoint(cable.get("b"), cable.get("endpointB"))
        warnings = list(dict.fromkeys(warning for warning in (warning_a, warning_b) if warning))
        action = cable.get("action", "stock")
        kind = cable.get("typeValue") or ""
        type_label = types.get(kind, "Unspecified")
        recorded, manual = _recorded_length(cable), cable.get("manualLengthMm")
        radius = profile["bend_radius_mm"].get(kind, profile["bend_radius_mm"]["default"])
        lead = 2 * profile["connector_lead_mm"]
        route = minimum = recommendation = bend = reserve = None
        estimated = False
        if cable.get("simple") is False:
            warnings = ["This cable has multiple terminations or a non-simple profile and needs manual sizing."]
        elif a and b:
            route = calculator.route(a, b, radius, lead)
            if route is None:
                warnings.append("Front-to-rear routing requires the rack's front-to-rear rail depth.")
            else:
                estimated = bool(warnings)
                bend = route.bends(radius)
                length = route.minimum(radius, lead, profile["reserve_percent"])
                minimum = math.ceil(length - 1e-9)
                reserve = length - route.path - lead - bend
                recommendation = min((size for size in catalog.get(kind, []) if size >= minimum), default=None)
                if recommendation is None:
                    warnings.append("No matching standard length in the cable catalog." if kind else "Choose a cable type for a standard length.")
        checked = manual if action == "new" else recorded
        if action != "new" and recorded is None:
            warnings.append("No length recorded in NetBox.")
        if minimum is not None and checked is not None and checked < minimum:
            status = "too-short"
            warnings.append("The entered cable length is below the calculated minimum.")
        elif warnings:
            status = "review"
        elif action == "stock" and recommendation is not None and recorded > recommendation:
            status = "potentially-shorter"
        else:
            status = "ready"

        if recommendation is not None and action in ("new", "stock"):
            counts[kind, type_label, recommendation] += 1
        details.append({
            "id": cable["id"], "action": action, "label": cable.get("label", ""),
            "endpointA": endpoint_a, "endpointB": endpoint_b, "type": kind, "typeLabel": type_label,
            "route": route.kind if route else None, "routeLabel": ROUTE_LABELS[route.kind] if route else "Manual sizing",
            "routeSegments": [{"label": label, "lengthMm": round(length, 1)} for label, length in route.segments
                              if length] if route else [],
            "pathMm": round(route.path, 1) if route else None, "connectorMm": lead if route else None,
            "bendMm": round(bend, 1) if route else None, "reserveMm": round(reserve, 1) if route else None,
            "minimumMm": minimum, "recommendedMm": recommendation, "recordedMm": recorded, "manualLengthMm": manual,
            "estimated": estimated, "status": status, "warnings": warnings,
        })
    review = [row for row in details if row["warnings"]]
    return {
        "details": details,
        "billOfMaterials": [
            {"type": kind, "typeLabel": label, "lengthMm": length, "quantity": count}
            for (kind, label, length), count in sorted(counts.items(), key=lambda item: (item[0][1], item[0][2]))
        ],
        "review": review,
        "billOfMaterialsReview": [row for row in review if row["action"] in ("new", "stock")],
    }


def report_csv(report, kind):
    """Return Excel-compatible bytes from the exact rows displayed by the editor."""
    output = io.StringIO(newline="")
    writer = csv.writer(output, delimiter=";")

    def safe(value):
        if isinstance(value, float):
            return format(Decimal(str(value)).normalize(), "f").replace(".", ",")
        if isinstance(value, str) and value.lstrip(" \t\r\n").startswith(("=", "+", "-", "@")):
            return "'" + value
        return value

    def endpoint_name(endpoint):
        return " / ".join(value for value in ((endpoint or {}).get("deviceName"), (endpoint or {}).get("portName")) if value)

    def detail_row(row):
        return [
            row["id"], row["action"], row["label"], endpoint_name(row["endpointA"]), endpoint_name(row["endpointB"]),
            row["typeLabel"], row["routeLabel"], row["pathMm"],
            " / ".join(f"{part['label']} {part['lengthMm']} mm" for part in row["routeSegments"]),
            row["connectorMm"], row["bendMm"], row["reserveMm"],
            row["minimumMm"], row["recommendedMm"], row["recordedMm"], row["manualLengthMm"],
            row["status"], " / ".join(row["warnings"]),
        ]

    headers = [
        "Cable ID", "Action", "Label", "End A", "End B", "Cable type", "Route", "Path (mm)", "Path segments", "Connector leads (mm)",
        "Bends (mm)", "Reserve (mm)", "Minimum (mm)", "Standard length (mm)", "NetBox length (mm)",
        "Manual length (mm)", "Status", "Review notes",
    ]
    if kind == "bom":
        writer.writerow(["Cable type", "Standard length (mm)", "Quantity"])
        writer.writerows([safe(row["typeLabel"]), row["lengthMm"], row["quantity"]] for row in report["billOfMaterials"])
        if report["billOfMaterialsReview"]:
            writer.writerow([])
            writer.writerow(["Review"])
            writer.writerow(headers)
            writer.writerows(map(safe, detail_row(row)) for row in report["billOfMaterialsReview"])
    else:
        writer.writerow(headers)
        writer.writerows(map(safe, detail_row(row)) for row in report["details"])
    return output.getvalue().encode("utf-8-sig")
