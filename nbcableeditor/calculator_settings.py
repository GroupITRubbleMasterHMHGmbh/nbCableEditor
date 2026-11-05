"""Global forms for physical routing profiles and purchasable cable sizes."""

import re
from decimal import Decimal
from urllib.parse import urlencode

from django import forms
from django.contrib import messages
from django.db import transaction
from django.shortcuts import redirect
from django.urls import reverse

from .calculator import BOOLEAN_SETTINGS, CHOICE_SETTINGS, NUMBER_SETTINGS, cable_types, configured_calculator
from .models import CableEditorSettings


MEASUREMENT_LABELS = {
    "reserve_percent": "Reserve (%)",
    "connector_lead_mm": "Straight connector lead per end (mm)",
    "left_channel_offset_mm": "Left channel offset (mm)",
    "right_channel_offset_mm": "Right channel offset (mm)",
    "direct_max_mm": "Maximum direct distance (mm)",
    "direct_gap_max_u": "Maximum empty space crossed (U)",
    "direct_intervening_max_devices": "Maximum intervening devices",
    "channel_preference_mm": "Extra distance allowed for a preferred channel (mm)",
    "balance_tolerance_mm": "Length tolerance for balancing (mm)",
}
CHECKBOX_LABELS = {
    "allow_direct_gap": "Allow direct across empty rack space",
    "allow_direct_intervening": "Allow direct across intervening devices",
}
SELECT_LABELS = {
    "strategy": "Routing strategy", "channels": "Available channels", "channel_selection": "Channel selection",
}
LENGTH_PATTERN = re.compile(r"\d{1,3}(?:\.\d{1,3})?")


def _decimal(label, low, high, required=True):
    return forms.DecimalField(
        label=label, min_value=low, max_value=high, decimal_places=2, required=required,
        widget=forms.NumberInput(attrs={"class": "form-control", "step": "any"}),
    )


class RoutingProfileForm(forms.Form):
    name = forms.CharField(label="Profile name", max_length=80, widget=forms.TextInput(attrs={"class": "form-control"}))
    set_default = forms.BooleanField(
        label="Use as the default for new plans and stock reports", required=False,
        widget=forms.CheckboxInput(attrs={"class": "form-check-input"}),
    )

    def __init__(self, *args, name, config, **kwargs):
        self.name = name
        self.config = config
        profile = config["profiles"][name or config["defaultProfile"]]
        initial = {**profile, "name": name, "set_default": name == config["defaultProfile"]}
        super().__init__(*args, initial=initial, **kwargs)
        for key, choices in CHOICE_SETTINGS.items():
            self.fields[key] = forms.ChoiceField(
                label=SELECT_LABELS[key], choices=choices, widget=forms.Select(attrs={"class": "form-select no-ts"}),
            )
        for key, (_, low, high) in NUMBER_SETTINGS.items():
            if key == "direct_intervening_max_devices":
                self.fields[key] = forms.IntegerField(
                    label=MEASUREMENT_LABELS[key], min_value=low, max_value=high,
                    widget=forms.NumberInput(attrs={"class": "form-control"}),
                )
            else:
                self.fields[key] = _decimal(MEASUREMENT_LABELS[key], low, high)
        for key in CHECKBOX_LABELS:
            self.fields[key] = forms.BooleanField(
                label=CHECKBOX_LABELS[key], required=False, widget=forms.CheckboxInput(attrs={"class": "form-check-input"}),
            )
        for key, label in {"default": "Default bend radius", **cable_types()}.items():
            self.fields[f"radius-{key}"] = _decimal(f"{label} (mm)", 0, 500, key == "default")
            self.initial[f"radius-{key}"] = profile["bend_radius_mm"].get(key)

    @property
    def route_fields(self):
        return [self[key] for key in (*CHOICE_SETTINGS, *NUMBER_SETTINGS)]

    @property
    def checkboxes(self):
        return [self[key] for key in (*BOOLEAN_SETTINGS, "set_default")]

    @property
    def type_radii(self):
        return [self[f"radius-{key}"] for key in cable_types()]

    @property
    def default_radius(self):
        return self["radius-default"]

    def clean_name(self):
        name = self.cleaned_data["name"]
        if any(existing != self.name and existing.casefold() == name.casefold() for existing in self.config["profiles"]):
            raise forms.ValidationError("A routing profile with this name already exists.")
        return name

    def profile(self):
        return {
            **{key: float(value) if isinstance(value, Decimal) else value
               for key in NUMBER_SETTINGS if (value := self.cleaned_data[key]) is not None},
            **{key: self.cleaned_data[key] for key in (*CHOICE_SETTINGS, *BOOLEAN_SETTINGS)},
            "bend_radius_mm": {
                key: float(value) for key in ("default", *cable_types())
                if (value := self.cleaned_data[f"radius-{key}"]) is not None
            },
        }


class LengthCatalogForm(forms.Form):
    def __init__(self, *args, catalog, **kwargs):
        super().__init__(*args, **kwargs)
        for kind, label in cable_types().items():
            self.fields[kind] = forms.CharField(
                label=label, required=False, max_length=900,
                initial=", ".join(f"{Decimal(value) / 1000:f}" for value in catalog.get(kind, [])),
                widget=forms.TextInput(attrs={"class": "form-control", "placeholder": "No standard lengths"}),
            )

    @property
    def cat_lengths(self):
        return [self[kind] for kind in self.fields if kind.startswith("cat")]

    @property
    def other_lengths(self):
        return [self[kind] for kind in self.fields if not kind.startswith("cat")]

    def clean(self):
        cleaned = super().clean()
        for kind, value in tuple(cleaned.items()):
            lengths = [length.strip() for length in value.split(",")] if value else []
            if any(not LENGTH_PATTERN.fullmatch(length) or not Decimal(length) for length in lengths):
                self.add_error(kind, "Use positive lengths in meters, separated by commas. Use a decimal point, e.g. 0.25, 0.5, 1.")
                continue
            cleaned[kind] = sorted({int(Decimal(length) * 1000) for length in lengths})
        return cleaned


def update_calculator_settings(request, route):
    action = request.POST.get("calculatorAction")
    with transaction.atomic():
        settings, _ = CableEditorSettings.objects.select_for_update().get_or_create(pk=1)
        config = configured_calculator(settings.options)
        profiles = config["profiles"]
        key = request.POST.get("profile_key") or None
        if key is not None and key not in profiles:
            messages.error(request, "This routing profile has already been removed or renamed.")
            return {}, redirect(f"{reverse(route)}#cable-calculator")
        if action == "save-catalog":
            form = LengthCatalogForm(request.POST, catalog=config["catalog"], prefix="catalog")
            if not form.is_valid():
                return {"catalog_form": form}, None
            config["catalog"] = {kind: lengths for kind, lengths in form.cleaned_data.items() if lengths}
        elif action == "delete-profile":
            if key is None or len(profiles) < 2:
                messages.error(request, "Keep at least one routing profile.")
                return {}, redirect(f"{reverse(route)}#cable-calculator")
            del profiles[key]
            if key == config["defaultProfile"]:
                config["defaultProfile"] = next(iter(profiles))
            key = config["defaultProfile"]
        elif action == "save-profile":
            form = RoutingProfileForm(request.POST, name=key, config=config, prefix="profile")
            if not form.is_valid():
                return {"profile_form": form, "selected_profile": key}, None
            name = form.cleaned_data["name"]
            if key and key != name:
                del profiles[key]
            profiles[name] = form.profile()
            if key == config["defaultProfile"] or form.cleaned_data["set_default"]:
                config["defaultProfile"] = name
            key = name
        else:
            messages.error(request, "Unknown calculator action.")
            return {}, redirect(f"{reverse(route)}#cable-calculator")
        settings.options = {**settings.options, "calculator": config}
        settings.save(update_fields=["options"])
    messages.success(request, "Cable Calculator settings saved.")
    query = f"?{urlencode({'calculator_profile': key})}" if key else ""
    return {}, redirect(f"{reverse(route)}{query}#cable-calculator")


def calculator_settings_context(request, options, overrides):
    config = configured_calculator(options)
    selected = request.GET.get("calculator_profile")
    if selected not in config["profiles"]:
        selected = config["defaultProfile"]
    if request.GET.get("new_calculator_profile"):
        selected = None
    selected = overrides.get("selected_profile", selected)
    return {
        "calculator_profiles": config["profiles"], "default_profile": config["defaultProfile"], "selected_profile": selected,
        "profile_form": overrides.get("profile_form", RoutingProfileForm(name=selected, config=config, prefix="profile")),
        "catalog_form": overrides.get("catalog_form", LengthCatalogForm(catalog=config["catalog"], prefix="catalog")),
    }
