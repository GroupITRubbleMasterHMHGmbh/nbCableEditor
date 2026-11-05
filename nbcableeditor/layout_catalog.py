"""Built-in layout artwork and the Device Type import overview."""

import json
import re
from dataclasses import dataclass
from functools import cache
from importlib.resources import files

from dcim.models import DeviceType
from django.core.paginator import Paginator
from django.db.models import Exists, OuterRef, Q
from django.shortcuts import render
from django.urls import reverse
from django.views.decorators.http import require_GET

from . import NbCableEditorConfig
from .models import LayoutRevision


# Alternate model names used by existing NetBox catalog entries.
MODEL_ALIASES = {
    "aruba-5406r-zl2-j9821a": ("Aruba 5406R zl2",),
    "aruba-5406r-zl2-j9850a": ("Aruba 5406R zl2",),
    "aruba-6000-12g-poe4-2sfp": ("Aruba 6000-12G-POE4-2SFP",),
    "aruba-6100-48g-poe4-4sfp-plus": ("Aruba 6100-48G-POE4-4SFP+",),
}
VENDOR_PREFIX = re.compile(
    r"^(?:HPE Aruba Networking|Aruba Networking|Hewlett[- ]Packard(?: Enterprise)?|Aruba|HPE|HP)\s+", re.I
)
VENDOR_NAMES = {
    "aruba", "arubanetworking", "arubanetworks", "hpe", "hpearubanetworking", "hp",
    "hewlettpackard", "hewlettpackardenterprise",
}


@dataclass(frozen=True)
class LayoutTemplate:
    slug: str
    name: str
    part_number: str
    kind: str
    model_keys: frozenset[str]
    vendor_model_keys: frozenset[str]

    @property
    def static_path(self):
        return f"nbcableeditor/layout-templates/{self.slug}.json"


def _model_key(value):
    # Keep '+' significant so a 1G SFP model cannot match an SFP+ model.
    return re.sub(r"[^a-z0-9+]", "", value.casefold())


@cache
def templates_for(kind):
    templates = []
    directory = files(__package__).joinpath("static", "nbcableeditor", "layout-templates")
    for path in directory.iterdir():
        if not path.name.endswith(".json") or path.name == "layout-template.schema.json":
            continue
        template = json.loads(path.read_text(encoding="utf-8"))
        if template["kind"] != kind:
            continue
        slug = path.name.removesuffix(".json")
        names = (template["name"], *MODEL_ALIASES.get(slug, ()))
        part_number = template.get("modelNumber", "")
        templates.append(LayoutTemplate(
            slug=slug,
            name=template["name"],
            part_number=part_number,
            kind=kind,
            model_keys=frozenset(_model_key(name) for name in (*names, part_number) if name),
            vendor_model_keys=frozenset(
                _model_key(VENDOR_PREFIX.sub("", name)) for name in names if VENDOR_PREFIX.match(name)
            ),
        ))
    return tuple(sorted(templates, key=lambda template: (template.name.casefold(), template.slug)))


def _suggestion(device_type, templates):
    part = (device_type.part_number or "").strip().casefold()
    if part:
        exact = [template for template in templates if template.part_number.casefold() == part]
        if len(exact) == 1:
            return exact[0], "Part number match"
        if len(exact) > 1:
            return None, "Several templates use this part number."

    model = _model_key(device_type.model)
    vendor = _model_key(device_type.manufacturer.name)
    vendor_model = _model_key(VENDOR_PREFIX.sub("", device_type.model)) if vendor in VENDOR_NAMES else ""
    matches = [
        template for template in templates
        if model in template.model_keys or vendor_model in template.vendor_model_keys
    ]
    if len(matches) > 1:
        return None, "Several templates match this model name."
    if matches:
        candidate = matches[0]
        if part and candidate.part_number:
            return None, "The model name matches a template with a different part number."
        return candidate, "Model name match"
    return None, "Choose a template to review."


@require_GET
def layout_imports(request):
    templates = templates_for("device")
    search = request.GET.get("q", "").strip()[:120]
    visible = DeviceType.objects.restrict(request.user).select_related("manufacturer")
    if search:
        visible = visible.filter(
            Q(model__icontains=search) | Q(part_number__icontains=search) | Q(manufacturer__name__icontains=search)
        )
    editable = DeviceType.objects.restrict(request.user, "change") if request.user.is_authenticated else DeviceType.objects.none()
    devices = visible.annotate(
        can_import=Exists(editable.filter(pk=OuterRef("pk"))),
        saved_layout=Exists(LayoutRevision.objects.filter(device_type_id=OuterRef("pk"), revision__gt=0)),
    ).order_by("manufacturer__name", "model", "pk")
    page = Paginator(devices, 24).get_page(request.GET.get("page"))
    cards = []
    for device in page:
        suggestion, reason = _suggestion(device, templates)
        cards.append({
            "device": device,
            "editor_url": reverse("plugins:nbcableeditor:layout", args=[device.pk]),
            "suggestion": suggestion,
            "reason": reason,
        })
    return render(request, "nbcableeditor/layout_imports.html", {
        "cards": cards,
        "editor_version": NbCableEditorConfig.version,
        "page": page,
        "search": search,
        "templates": templates,
    })
