"""Describe and resolve the fields that can be printed on a rack drawing."""

import json
import re
from collections import defaultdict
from dataclasses import dataclass

from dcim.models import Device, DeviceType, Module, ModuleType
from django.utils.translation import override
from extras.choices import CustomFieldTypeChoices, CustomFieldUIVisibleChoices
from extras.models import CustomField


TOKEN = re.compile(r"\{((?:device|module)(?:\.[A-Za-z0-9_]+)+)\}")
MAX_FIELD_TEXT = 512
MAX_RENDERED_TEXT = 2048
OBJECT_FIELDS = (CustomFieldTypeChoices.TYPE_OBJECT, CustomFieldTypeChoices.TYPE_MULTIOBJECT)

# Keep the same catalog for the picker and rack rendering. Configuration context, media,
# and internal data such as caches and serialized custom fields are excluded.
SOURCES = {
    "device": (Device, "Device", (
        "name", "serial", "asset_tag", "status", "description", "comments", "role", "tenant", "platform",
        "site", "location", "rack", "position", "face", "airflow", "primary_ip4", "primary_ip6", "oob_ip",
        "cluster", "virtual_chassis", "vc_position", "vc_priority", "latitude", "longitude", "owner",
        "created", "last_updated",
    )),
    "device.type": (DeviceType, "Device type", (
        "model", "manufacturer", "part_number", "slug", "u_height", "is_full_depth", "exclude_from_utilization",
        "airflow", "subdevice_role", "weight", "weight_unit", "default_platform", "description", "comments",
        "owner", "created", "last_updated",
    )),
    "module": (Module, "Module", (
        "serial", "asset_tag", "status", "description", "comments", "owner", "created", "last_updated",
    )),
    "module.type": (ModuleType, "Module type", (
        "model", "manufacturer", "part_number", "profile", "airflow", "weight", "weight_unit", "description",
        "comments", "owner", "created", "last_updated",
    )),
}
ALIASES = {
    "device": (("label", "name", "Label"), ("type", "device_type", "Device type")),
    "module": (("type", "module_type", "Module type"), ("bay", "module_bay", "Module bay")),
}


@dataclass(frozen=True)
class LayoutField:
    token: str
    scope: str
    label: str
    group: str
    field: object


def _catalog(scopes, requested=None):
    for scope in scopes:
        model, group, names = SOURCES[scope]
        for key, attr, label in ALIASES.get(scope, ()):
            yield LayoutField(f"{scope}.{key}", scope, label, group, model._meta.get_field(attr))
        for name in names:
            field = model._meta.get_field(name)
            yield LayoutField(f"{scope}.{name}", scope, str(field.verbose_name).capitalize(), group, field)

        prefix = f"{scope}.custom."
        if requested is not None:
            custom_names = [token.removeprefix(prefix) for token in requested if token.startswith(prefix)]
            if not custom_names:
                continue
        # NetBox shows assigned custom fields on readable objects independently of access to field configuration.
        fields = CustomField.objects.get_for_model(model).exclude(ui_visible=CustomFieldUIVisibleChoices.HIDDEN)
        if requested is not None:
            fields = fields.filter(name__in=custom_names)
        fields = fields.select_related("choice_set").order_by("weight", "label", "name")
        for field in fields:
            yield LayoutField(prefix + field.name, scope, str(field), f"{group} · Custom fields", field)


@override("en")
def layout_placeholder_fields(owner):
    is_module = isinstance(owner, ModuleType)
    scopes = SOURCES if is_module else ("device", "device.type")
    examples = {
        "device.name": "Example device", "device.label": "Example label", "module.bay": "Example bay",
        "device.type": "Example device type" if is_module else owner.model,
        "device.type.model": "Example device type" if is_module else owner.model,
        "module.type": owner.model, "module.type.model": owner.model,
    }
    return [
        {"token": field.token, "label": field.label, "group": field.group,
         "example": examples.get(field.token, "Example " + field.label.lower())}
        for field in _catalog(scopes)
    ]


def _requested_tokens(drawings):
    for drawing in drawings:
        for face in drawing.values():
            for item in face.get("items", ()):
                if item["kind"] == "text":
                    yield from TOKEN.findall(item["text"])
                elif item["kind"] == "rectangle" and item.get("label"):
                    yield from TOKEN.findall(item["label"]["text"])


def _text(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    else:
        value = str(value)
    return value[:MAX_FIELD_TEXT]


def _object_name(obj):
    if isinstance(obj, (DeviceType, ModuleType)):
        return obj.model
    if isinstance(obj, Device):
        return obj.name or obj.asset_tag or f"Device {obj.pk}"
    if isinstance(obj, Module):
        return obj.serial or obj.asset_tag or f"Module {obj.pk}"
    return str(obj)


class RackPlaceholderValues:
    def __init__(self, user, drawings, subjects):
        requested = set(_requested_tokens(drawings))
        # Legacy names used the displayed device name, including the virtual-chassis fallback.
        device_name_tokens = requested & {"device.name", "device.label"}
        if device_name_tokens:
            requested.add("device.virtual_chassis")
        if "device.name" in device_name_tokens:
            requested.update(("device.type.model", "device.type.manufacturer"))

        self.scopes = {}
        self.values = defaultdict(dict)
        relations = defaultdict(list)
        for spec in _catalog(SOURCES, requested):
            self.scopes[spec.token] = spec.scope
            if spec.token not in requested:
                continue
            field = spec.field
            for obj in subjects[spec.scope].values():
                row = self.values[spec.scope, obj.pk]
                if isinstance(field, CustomField):
                    value = obj.custom_field_data.get(field.name)
                    if field.type in OBJECT_FIELDS:
                        related_model = field.related_object_type.model_class() if field.related_object_type else None
                        ids = value if field.type == CustomFieldTypeChoices.TYPE_MULTIOBJECT else [value]
                        if related_model and isinstance(ids, list):
                            ids = [pk for pk in ids if type(pk) is int and pk > 0]
                            if ids:
                                relations[related_model].append((row, spec.token, ids))
                        continue
                    if field.type == CustomFieldTypeChoices.TYPE_SELECT and isinstance(value, str):
                        value = field.get_choice_label(value)
                    if field.type == CustomFieldTypeChoices.TYPE_MULTISELECT and isinstance(value, list):
                        value = ", ".join(str(field.get_choice_label(key)) for key in value if isinstance(key, str))
                elif field.is_relation:
                    if pk := getattr(obj, field.attname):
                        relations[field.related_model].append((row, spec.token, [pk]))
                    continue
                else:
                    value = getattr(obj, field.attname)
                    if field.choices and value is not None:
                        value = getattr(obj, f"get_{field.name}_display")()
                row[spec.token] = _text(value)

        for model, occurrences in relations.items():
            manager = model._default_manager
            if not hasattr(manager, "restrict"):
                continue
            ids = {pk for _, _, keys in occurrences for pk in keys}
            permitted = {
                obj.pk: _object_name(obj) for obj in manager.restrict(user).filter(pk__in=ids)
            }
            for row, token, keys in occurrences:
                row[token] = _text(", ".join(permitted[pk] for pk in keys if pk in permitted))

        if device_name_tokens:
            for device in subjects["device"].values():
                row = self.values["device", device.pk]
                label = device.name or ""
                if not label and (chassis := row.get("device.virtual_chassis")):
                    label = f"{chassis}:{device.vc_position}"
                row["device.label"] = label
                if "device.name" in device_name_tokens:
                    type_row = self.values.get(("device.type", device.device_type_id), {})
                    make = " ".join(filter(None, (type_row.get("device.type.manufacturer"), type_row.get("device.type.model"))))
                    name = label or make or "Device"
                    suffix = device.asset_tag or (str(device.pk) if not label else "")
                    row["device.name"] = f"{name} ({suffix})" if suffix else name

    def render(self, text, subject_ids):
        def value(match):
            token = match[1]
            if scope := self.scopes.get(token):
                return self.values.get((scope, subject_ids.get(scope)), {}).get(token, "")
            if any(token.startswith(f"{scope}.custom.") for scope in SOURCES):
                return ""
            return match[0]

        return TOKEN.sub(value, text)[:MAX_RENDERED_TEXT]
