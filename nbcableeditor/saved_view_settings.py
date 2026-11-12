import re

from .configuration import CONNECTION_FIELDS, DIRECTORY_FIELDS
from .rack_features import VIEW_TOOLBAR_FEATURES
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
        "devices": lambda ids: _array(ids, is_object_id, 1000),
        "deviceTypes": lambda ids: _array(ids, is_object_id, 1000),
        "portRanges": lambda ranges: _text(ranges, 1024),
    }
    return isinstance(value, dict) and value.keys() == validators.keys() and _fields(
        value, "connection endpoint criteria", validators,
    )


def _filter_length(value):
    return value is None or (type(value) in (int, float) and 0 <= value <= 10**12)


_endpoint_choice = _choices("any", "a", "b", "both")
FILTER_RULES = {
    "between": {"a": _endpoint_criteria, "b": _endpoint_criteria, "directional": _boolean},
    "endpoint": {"endpoint": _endpoint_choice, "criteria": _endpoint_criteria},
    "cable-type": {"values": lambda types: bool(types) and _array(types, lambda value: bool(value) and _text(value, 100), 1000)},
    "length": {"min": _filter_length, "max": _filter_length},
    "vlan": {
        "endpoint": _endpoint_choice, "membership": _choices("any", "tagged", "untagged"),
        "ids": lambda value: _vlan_ranges(value, optional=True),
    },
}


def _connection_filter(value):
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
        fields = {key: value for key, value in node.items() if key != "kind"}
        if kind == "group":
            if (fields.keys() != {"operator", "children"} or fields["operator"] not in ("and", "or")
                    or not isinstance(fields["children"], list) or len(fields["children"]) > 100):
                raise JsonRequestError("Use AND or OR to combine connection filter rules.", 400)
            if depth and not fields["children"]:
                raise JsonRequestError("Each nested filter group needs a condition.", 400)
            pending.extend((child, depth + 1) for child in fields["children"])
        elif not isinstance(kind, str) or kind not in FILTER_RULES or fields.keys() != FILTER_RULES[kind].keys():
            raise JsonRequestError("Choose a valid connection filter rule.", 400)
        else:
            _fields(fields, "connection filter rules", FILTER_RULES[kind])
            if kind == "length":
                minimum, maximum = fields["min"], fields["max"]
                if (minimum is None and maximum is None
                        or minimum is not None and maximum is not None and minimum > maximum):
                    raise JsonRequestError("Enter a minimum or maximum cable length, with the lower value first.", 400)
    return True


def clean_view_settings(value):
    _fields(value, "rack view settings", {
        "display": lambda fields: _fields(fields, "display settings", DISPLAY_FIELDS),
        "rack": lambda fields: _fields(fields, "rack display settings", RACK_FIELDS),
        "listFields": lambda fields: _fields(fields, "list display settings", LIST_FIELDS),
        "selectedConnections": lambda ids: _array(ids, is_object_id, 10_000),
        "connectionFilter": _connection_filter,
        "toolbar": lambda fields: _fields(fields, "toolbar settings", TOOLBAR_FIELDS),
    })
    return value
