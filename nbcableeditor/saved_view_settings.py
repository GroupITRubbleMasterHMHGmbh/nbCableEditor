import re

from .configuration import CONNECTION_FIELDS, DIRECTORY_FIELDS
from .rack_features import TRACE_DESTINATION_FEATURES, VIEW_TOOLBAR_FEATURES
from .request_data import JsonRequestError


def is_object_id(value):
    return type(value) is int and 0 < value < 2**53


def _object(value, label):
    if not isinstance(value, dict):
        raise JsonRequestError(f"Enter valid {label}.", 400)
    return value


def _fields(value, label, validators):
    for key, entry in _object(value, label).items():
        if key not in validators or not validators[key](entry):
            raise JsonRequestError(f"Enter valid {label}.", 400)
    return True


def _boolean(value):
    return type(value) is bool


def _text(value, length):
    return isinstance(value, str) and len(value) <= length


def _choices(*values):
    return lambda value: value in values


def _array(value, validator, limit):
    return isinstance(value, list) and len(value) <= limit and all(map(validator, value))


def _zoom(value):
    if not _text(value, 30):
        return False
    if value in ("auto", "horizontal-fit", "vertical-fit", "fit"):
        return True
    try:
        return 0.25 <= float(value) <= 8
    except ValueError:
        return False


def _vlan_ranges(value, *, optional=False):
    if not _text(value, 1024):
        return False
    if not value.strip():
        return optional
    separator = r"[-–]" if optional else "-"
    pattern = rf"([0-9]{{1,4}})(?:\s*{separator}\s*([0-9]{{1,4}}))?"
    for piece in value.split(","):
        match = re.fullmatch(pattern, piece.strip())
        if not match or not 1 <= int(match[1]) <= int(match[2] or match[1]) <= 4094:
            return False
    return True


def _hex_color(value):
    return _text(value, 7) and bool(re.fullmatch(r"#[0-9a-fA-F]{6}", value))


def _vlan_colors(value):
    def rule(entry):
        return (
            isinstance(entry, dict) and entry.keys() == {"ids", "color"}
            and _vlan_ranges(entry["ids"]) and _hex_color(entry["color"])
        )

    return _fields(value, "VLAN color settings", {
        "rules": lambda rules: _array(rules, rule, 1000),
        "fallback": lambda color: color == "" or _hex_color(color),
    })


def _device_ids(value):
    return _text(value, 100_000) and (
        not value or all(re.fullmatch(r"[1-9][0-9]{0,15}", entry) and is_object_id(int(entry))
                         for entry in value.split(","))
    )


def _device_gaps(value):
    return (
        isinstance(value, dict) and len(value) <= 1000
        and all(len(key) <= 60 and re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?:-?[0-9]+(?:\.[0-9]+)?", key)
                and type(gap) is int and 0 <= gap <= 240 for key, gap in value.items())
    )


DISPLAY_FIELDS = {
    "connections": _boolean, "directory": _boolean, "trim": _boolean, "virtualCombine": _boolean,
    "externalLocations": _boolean, "compactEmptyUnits": _boolean,
    **dict.fromkeys(TRACE_DESTINATION_FEATURES, _boolean),
    "connectionsOpen": _boolean, "directoryOpen": _boolean,
    "zoom": _zoom, "lines": _choices("all", "bundles", "selected", "filtered", "none"),
    "images": _choices("visible", "faded", "hidden"),
    "interfaceHighlight": _choices("all", "free", "used"),
    "routingStrategy": _choices("balanced", "pcb"),
    "portFill": _choices("status", "vlan"), "vlanColors": _vlan_colors,
}
RACK_FIELDS = {
    "face": _choices("", "front", "rear", "both"),
    "devices": _device_ids,
    "hiddenRows": lambda value: _text(value, 100_000) and (
        not value or bool(re.fullmatch(r"[1-9][0-9]*:(?:front|rear):[1-9][0-9]*(?:,[1-9][0-9]*:(?:front|rear):[1-9][0-9]*)*", value))
    ),
    "cableDevice": lambda value: _device_ids(value) and "," not in value,
    "vlan": lambda value: _text(value, 1024),
    "vlanKind": _choices("any", "tagged", "untagged"),
    "search": lambda value: _text(value, 4096),
    "offImage": _boolean,
    "positionIndicator": _boolean,
    "connectionSearch": lambda value: _text(value, 4096),
    "deviceGaps": _device_gaps,
    "expandedBundle": lambda value: value is None or _text(value, 1024),
}
LIST_FIELDS = {
    f"{kind}:{name}": _boolean
    for kind, fields in (("connection", CONNECTION_FIELDS), ("directory", DIRECTORY_FIELDS))
    for name, _ in fields
}
TOOLBAR_FIELDS = {key: _boolean for key in VIEW_TOOLBAR_FEATURES}


def _endpoint_criteria(value):
    validators = {
        "portRanges": lambda ranges: _text(ranges, 1024),
        **{
            key: _filter_ids for key in (
                "devices", "deviceTypes", "deviceRoles", "deviceTags", "deviceTypeTags", "deviceManufacturers",
                "interfaces", "modules", "moduleTypes", "moduleTags", "moduleTypeTags", "moduleManufacturers",
            )
        },
    }
    return _fields(value, "connection endpoint criteria", validators)


def _filter_ids(values):
    return _array(values, is_object_id, 1000)


def _filter_length(value):
    return value is None or (type(value) in (int, float) and 0 <= value <= 10**12)


_endpoint_choice = _choices("any", "a", "b", "both")
_vlan_mode = _choices("", "access", "tagged", "tagged-all", "q-in-q")
PORT_RULES = {"endpoint", "trace", "vlan", "vlan-mode"}
TRACE_PLACE_SELECTIONS = (
    "end-in-racks", "end-in-locations", "end-in-sites",
    "along-racks", "along-locations", "along-sites", "along-racks-in-locations",
)
TRACE_PLACE_SCOPES = (
    *TRACE_PLACE_SELECTIONS,
    "end-outside-rack", "end-outside-location", "end-outside-site",
    "end-in-current-rack", "end-in-current-location", "end-in-current-site",
    "along-current-rack", "along-current-location", "along-current-site",
)
TRACE_PLACE_RULE = {"scope": _choices(*TRACE_PLACE_SCOPES), "values": _filter_ids}
FILTER_RULES = {
    "between": {"a": _endpoint_criteria, "b": _endpoint_criteria, "directional": _boolean},
    "endpoint": {"endpoint": _endpoint_choice, "criteria": _endpoint_criteria},
    "trace": {"scope": _choices("any", "next"), "criteria": _endpoint_criteria},
    "cable-type": {"values": lambda types: bool(types) and _array(types, lambda value: bool(value) and _text(value, 100), 1000)},
    "length": {"min": _filter_length, "max": _filter_length},
    "vlan": {
        "endpoint": _endpoint_choice, "membership": _choices("any", "tagged", "untagged"),
        "ids": lambda value: _vlan_ranges(value, optional=True),
    },
    "vlan-mode": {"endpoint": _endpoint_choice, "values": lambda modes: bool(modes) and _array(modes, _vlan_mode, 5)},
    "location": {
        "scope": _choices("within-rack", "outside-rack", "other-rack", "other-site", "selected-racks", "selected-sites"),
        "values": _filter_ids,
    },
}


def _connection_filter(value, *, ports=False):
    if value is None:
        return True
    if _object(value, "connection filter").get("kind") != "group":
        raise JsonRequestError("The connection filter needs a root group.", 400)
    pending = [(value, 0)]
    count = 0
    while pending:
        node, depth = pending.pop()
        count += 1
        if depth > 8 or count > 100:
            raise JsonRequestError("The connection filter can contain up to 100 entries and 8 levels below its root.", 400)
        kind = _object(node, "connection filter rules").get("kind")
        if "negated" in node and not _boolean(node["negated"]):
            raise JsonRequestError("Choose whether to negate the filter entry.", 400)
        fields = {key: value for key, value in node.items() if key not in {"kind", "negated"}}
        trace_place = kind == "trace" and fields.get("scope") in TRACE_PLACE_SCOPES
        if kind == "group":
            if (fields.keys() != {"operator", "children"} or fields["operator"] not in ("and", "or")
                    or not isinstance(fields["children"], list) or len(fields["children"]) > 100):
                raise JsonRequestError("Use AND or OR to combine connection filter rules.", 400)
            pending.extend((child, depth + 1) for child in fields["children"])
        elif (not isinstance(kind, str) or kind not in FILTER_RULES or (ports and kind not in PORT_RULES)):
            raise JsonRequestError("Choose a valid connection filter rule.", 400)
        else:
            validators = TRACE_PLACE_RULE if trace_place else FILTER_RULES[kind]
            if fields.keys() != validators.keys():
                raise JsonRequestError("Choose a valid connection filter rule.", 400)
            _fields(fields, "connection filter rules", validators)
            if trace_place and fields["scope"] in TRACE_PLACE_SELECTIONS and not fields["values"]:
                raise JsonRequestError("Choose at least one trace rack, location, or site.", 400)
            if kind == "trace" and not trace_place and not any(
                value.strip() if isinstance(value, str) else value for value in fields["criteria"].values()
            ):
                raise JsonRequestError("Choose an inventory attribute or port range for the trace condition.", 400)
            if kind == "location" and fields["scope"].startswith("selected-") and not fields["values"]:
                raise JsonRequestError("Choose at least one destination rack or site.", 400)
            if kind == "length":
                minimum, maximum = fields["min"], fields["max"]
                if (minimum is None and maximum is None
                        or minimum is not None and maximum is not None and minimum > maximum):
                    raise JsonRequestError("Enter a minimum or maximum cable length, with the lower value first.", 400)
    return True


def _number_between(minimum, maximum):
    return lambda value: type(value) in (int, float) and minimum <= value <= maximum


RULE_ACTION_FIELDS = {
    "interface": {
        "visible": _boolean,
        "edit": _boolean,
        "color": _hex_color,
        "icon": _choices("none", "red-x", "green-check", "circle", "rectangle"),
        "iconColor": _hex_color,
        "hideLabel": _boolean,
        "fontWeight": _choices("normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"),
        "labelColor": _hex_color,
        "connect": _boolean,
        "disconnect": _boolean,
        "hideCable": _boolean,
        "virtualCable": _boolean,
    },
    "connection": {
        "visible": _boolean,
        "edit": _boolean,
        "virtualPipe": _boolean,
        "hover": _boolean,
        "details": _boolean,
        "color": _hex_color,
        "luminosity": _number_between(0, 200),
        "opacity": _number_between(0, 1),
        "lineStyle": _choices("solid", "dashed", "dotted"),
        "width": _number_between(0.5, 20),
    },
    "device": {
        "edit": _boolean,
        "grayBox": _boolean,
        "interfaces": _boolean,
        "cables": _boolean,
        "front": _boolean,
        "rear": _boolean,
    },
}


def _ordered_rules(value, kind):
    def rule(entry):
        _object(entry, f"{kind} rule")
        if not {"condition", "actions"}.issubset(entry) or entry["condition"] is None:
            raise JsonRequestError("Each rule needs conditions and actions.", 400)
        return _fields(entry, f"{kind} rule", {
            "name": lambda name: _text(name, 200),
            "enabled": _boolean,
            "condition": lambda condition: _connection_filter(condition, ports=kind != "connection"),
            "actions": lambda actions: _fields(actions, f"{kind} rule actions", RULE_ACTION_FIELDS[kind]),
            "halt": _boolean,
        })

    return _array(value, rule, 100)


def clean_view_settings(value):
    _fields(value, "rack view settings", {
        "display": lambda fields: _fields(fields, "display settings", DISPLAY_FIELDS),
        "rack": lambda fields: _fields(fields, "rack display settings", RACK_FIELDS),
        "listFields": lambda fields: _fields(fields, "list display settings", LIST_FIELDS),
        "selectedConnections": lambda ids: _array(ids, is_object_id, 10_000),
        "connectionFilter": _connection_filter,
        "portFilter": lambda tree: _connection_filter(tree, ports=True),
        "portFilterAction": _choices("block", "hide", "mark"),
        "interfaceRules": lambda rules: _ordered_rules(rules, "interface"),
        "connectionRules": lambda rules: _ordered_rules(rules, "connection"),
        "deviceRules": lambda rules: _ordered_rules(rules, "device"),
        "toolbar": lambda fields: _fields(fields, "toolbar settings", TOOLBAR_FIELDS),
    })
    return value
