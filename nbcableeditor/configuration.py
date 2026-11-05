from django import forms
from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.shortcuts import redirect, render
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from dcim.models import Cable
from extras.choices import CustomFieldTypeChoices, CustomFieldUIVisibleChoices
from extras.models import CustomField

from .models import CableEditorSettings


SETTINGS_PERMISSION = "nbcableeditor.change_cableeditorsettings"
SETTINGS_ROUTE = "plugins:nbcableeditor:settings"

ZOOM_CHOICES = (
    ("auto", "Auto"), ("horizontal-fit", "Horizontal Fit"), ("vertical-fit", "Vertical Fit"),
    ("0.5", "50%"), ("0.75", "75%"), ("1", "100%"), ("1.25", "125%"), ("1.5", "150%"),
    ("1.75", "175%"), ("2", "200%"), ("2.5", "250%"), ("3", "300%"),
)
DIRECTORY_FIELDS = (
    ("vlan", "VLANs"), ("peer-vlan", "Peer VLANs"), ("label", "Label"),
    ("type", "Type"), ("description", "Description"), ("status", "Status"),
)
CONNECTION_FIELDS = (
    ("vlan", "VLANs"), ("type", "Type"), ("status", "Status"),
    ("description", "Description"), ("length", "Length"), ("profile", "Profile"),
)
CABLE_FIELDS = (
    ("status", "Status"), ("type", "Type"), ("profile", "Profile"), ("color", "Color"),
    ("length", "Length"), ("label", "Label"), ("description", "Description"), ("tags", "Tags"),
    ("comments", "Comments"), ("trace", "Cable trace"), ("portDetails", "Endpoint port details"),
)
PORT_FIELDS = (
    ("type", "Type"), ("status", "Status"), ("vlan", "VLANs"), ("poe", "PoE"),
    ("description", "Description"), ("tags", "Tags"), ("label", "Label"), ("speed", "Speed"),
    ("duplex", "Duplex"), ("mtu", "MTU"), ("managementOnly", "Management only"),
)

SETTINGS_GROUPS = (
    ("View defaults", "Starting point for users who have not chosen a view in their browser.", (
        "face", "zoom", "lines", "routingStrategy", "images", "portFill", "interfaceHighlight",
        "connections", "directory", "trim", "virtualCombine",
    )),
    ("Drawing", "Clearances are targets at 100% zoom. Routing adapts to the available space and the selected strategy.", (
        "deviceClearance", "cableGap", "horizontalGap", "tubeGap", "tubeParallelGap",
        "deviceGap", "pcbDeviceGap", "deviceGapStep",
    )),
    ("Ports and hover", "Port contours scale with the marker. The configured width caps that scaling.", (
        "portBorderWidth", "portBorderFree", "portBorderConnected", "portBorderUnavailable", "hoverDelay",
    )),
    ("Displayed fields", "Choose the initial list columns and the fields shown by default in each details dialog.", (
        "directoryFields", "connectionFields", "cableDetailFields", "portDetailFields", "cableCustomFields",
    )),
)
DISPLAY_KEYS = SETTINGS_GROUPS[-1][2]


def _choice(label, default, *choices):
    return forms.ChoiceField(label=label, initial=default, choices=choices)


def _toggle(label, default=False):
    return forms.BooleanField(label=label, initial=default, required=False)


def _pixels(label, default, minimum, maximum, *, fractional=False):
    kwargs = dict(label=label, initial=default, min_value=minimum, max_value=maximum, required=default is not None)
    if default is None:
        kwargs["help_text"] = "Leave blank to use the default port contour width."
    if fractional:
        return forms.DecimalField(**kwargs, decimal_places=1)
    return forms.IntegerField(**kwargs)


def _fields(label, choices=(), default=(), help_text=""):
    return forms.MultipleChoiceField(
        label=label, choices=choices, initial=list(default), required=False,
        widget=forms.CheckboxSelectMultiple, help_text=help_text,
    )


class CableEditorSettingsForm(forms.Form):
    face = _choice("Rack side", "front", ("front", "Front"), ("rear", "Rear"), ("both", "Both"))
    zoom = _choice("Zoom", "auto", *ZOOM_CHOICES)
    lines = _choice("Lines", "all", ("all", "All"), ("bundles", "Bundles"),
                    ("selected", "Selected only"), ("none", "Hidden"))
    routingStrategy = _choice("Routing strategy", "balanced", ("balanced", "Balanced"), ("pcb", "PCB-style"))
    images = _choice("Device images", "visible", ("visible", "Visible"), ("faded", "50% opacity"), ("hidden", "Hidden"))
    portFill = _choice("Port fill", "status", ("status", "Connection status"), ("vlan", "Untagged VLAN"))
    interfaceHighlight = _choice("Interfaces", "all", ("all", "All"), ("free", "Highlight Free"),
                                 ("used", "Highlight Used"))
    connections = _toggle("Show Connections", True)
    directory = _toggle("Show Interface Directory", True)
    trim = _toggle("Trim to visible ports")
    virtualCombine = _toggle("Virtual combine")
    deviceClearance = _pixels("Cable clearance from devices (px)", 25, 5, 65)
    cableGap = _pixels("Parallel cable spacing (px)", 4.5, 2, 20, fractional=True)
    horizontalGap = _pixels("Additional horizontal spacing (px)", 5, 0, 30)
    tubeGap = _pixels("Clearance from tube edge (px)", 15, 0, 50)
    tubeParallelGap = _pixels("Parallel clearance from tube edge (px)", 25, 0, 75)
    deviceGap = _pixels("Virtual device gap, Balanced (px)", 64, 0, 240)
    pcbDeviceGap = _pixels("Virtual device gap, PCB-style (px)", 102, 0, 240)
    deviceGapStep = _pixels("Virtual device gap step for + and − (px)", 48, 4, 120)
    portBorderWidth = _pixels("Default port contour (px)", 3, 1, 8, fractional=True)
    portBorderFree = _pixels("Free port contour (px)", None, 1, 8, fractional=True)
    portBorderConnected = _pixels("Connected port contour (px)", None, 1, 8, fractional=True)
    portBorderUnavailable = _pixels("Unavailable port contour (px)", None, 1, 8, fractional=True)
    hoverDelay = forms.IntegerField(label="Hover delay (ms)", initial=100, min_value=0, max_value=1000)
    directoryFields = _fields("Interface Directory", DIRECTORY_FIELDS, ("vlan", "status"))
    connectionFields = _fields("Connections", CONNECTION_FIELDS, ("vlan",))
    cableDetailFields = _fields("Cable Details", CABLE_FIELDS, (key for key, _ in CABLE_FIELDS))
    portDetailFields = _fields("Port Details", PORT_FIELDS, (key for key, _ in PORT_FIELDS))
    cableCustomFields = _fields("Cable custom fields", help_text="Selected fields are shown in Cable Details.")

    def __init__(self, *args, custom_fields, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["cableCustomFields"].choices = [
            (field.name, field.label or field.name) for field in custom_fields
        ]
        for field in self.fields.values():
            widget = field.widget
            if isinstance(widget, (forms.CheckboxInput, forms.CheckboxSelectMultiple)):
                widget.attrs["class"] = "form-check-input"
            elif isinstance(widget, forms.Select):
                widget.attrs["class"] = "form-select no-ts"
            else:
                widget.attrs["class"] = "form-control"

    def clean(self):
        values = super().clean()
        gap, parallel = values.get("tubeGap"), values.get("tubeParallelGap")
        if gap is not None and parallel is not None and parallel < gap:
            self.add_error("tubeParallelGap", "Parallel clearance must be at least the tube clearance.")
        return values

    def options(self):
        return {
            key: float(value) if isinstance(self.fields[key], forms.DecimalField) and value is not None else value
            for key, value in self.cleaned_data.items()
        }


def _configured_options():
    defaults = {name: field.initial for name, field in CableEditorSettingsForm.base_fields.items()}
    stored = CableEditorSettings.objects.filter(pk=1).values_list("options", flat=True).first() or {}
    options = {**defaults, **stored}
    if options["zoom"] == "fit":
        options["zoom"] = "horizontal-fit"
    return options


def can_manage_editor_settings(user):
    if not user.is_authenticated or not user.has_perm(SETTINGS_PERMISSION):
        return False
    if user.is_superuser:
        return True
    settings = CableEditorSettings.objects.filter(pk=1).only("id").first()
    return settings is not None and user.has_perm(SETTINGS_PERMISSION, settings)


def _cable_fields():
    return CustomField.objects.get_for_model(Cable).exclude(
        ui_visible=CustomFieldUIVisibleChoices.HIDDEN,
    ).select_related("choice_set")


def nbcableeditor_options():
    options = _configured_options()
    names = options["cableCustomFields"]
    fields = {field.name: field for field in _cable_fields().filter(name__in=names)} if names else {}
    fields = [fields[name] for name in names if name in fields]
    display = {key: options.pop(key) for key in DISPLAY_KEYS}
    display["cableCustomFields"] = [field.name for field in fields]
    display["cableCustomFieldLabels"] = {field.name: field.label or field.name for field in fields}
    return {**options, "display": display}, fields


def cable_custom_values(user, cables, fields):
    values = {cable.pk: {} for cable in cables} if fields else {}
    for field in fields:
        raw = {cable.pk: cable.custom_field_data.get(field.name) for cable in cables}
        if field.type in (CustomFieldTypeChoices.TYPE_OBJECT, CustomFieldTypeChoices.TYPE_MULTIOBJECT):
            single = field.type == CustomFieldTypeChoices.TYPE_OBJECT
            references = {
                pk: [value] if single else [item for item in value if type(item) is int]
                for pk, value in raw.items() if (type(value) is int if single else isinstance(value, list))
            }
            ids = {object_id for group in references.values() for object_id in group}
            model = field.related_object_type.model_class() if field.related_object_type else None
            manager = getattr(model, "objects", None)
            readable = (
                {obj.pk: str(obj) for obj in manager.restrict(user).filter(pk__in=ids)}
                if ids and hasattr(manager, "restrict") else {}
            )
            for pk, group in references.items():
                visible = [readable[object_id] for object_id in group if object_id in readable]
                if visible:
                    values[pk][field.name] = visible[0] if single else visible
            continue
        for pk, value in raw.items():
            if field.ui_visible == CustomFieldUIVisibleChoices.ALWAYS or value not in (None, "", [], {}):
                if isinstance(value, str) and field.type == CustomFieldTypeChoices.TYPE_SELECT:
                    value = field.get_choice_label(value)
                elif isinstance(value, list) and field.type == CustomFieldTypeChoices.TYPE_MULTISELECT:
                    value = [field.get_choice_label(item) for item in value if isinstance(item, str)]
                values[pk][field.name] = value
    return values


@csrf_protect
@require_http_methods(["GET", "POST"])
def editor_settings(request):
    if not can_manage_editor_settings(request.user):
        raise PermissionDenied
    custom_fields = list(_cable_fields())
    form = CableEditorSettingsForm(
        request.POST if request.method == "POST" else None, initial=_configured_options(), custom_fields=custom_fields,
    )
    if request.method == "POST" and form.is_valid():
        CableEditorSettings.objects.update_or_create(pk=1, defaults={"options": form.options()})
        messages.success(request, "Cable Editor settings saved.")
        return redirect(SETTINGS_ROUTE)
    return render(request, "nbcableeditor/settings.html", {
        "groups": [(title, help_text, [form[key] for key in keys]) for title, help_text, keys in SETTINGS_GROUPS],
        "form": form,
    })
