from itertools import islice
from urllib.parse import urlencode

from dcim.choices import RackStatusChoices
from dcim.models import Device, Location, Rack, RackRole, Site, SiteGroup
from django import forms
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.core.paginator import Paginator
from django.db import IntegrityError, router, transaction
from django.db.models import Count, OuterRef, Subquery
from django.db.models.functions import Coalesce
from django.http import Http404, HttpResponseBadRequest
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods
from tenancy.models import Tenant
from utilities.forms.fields import DynamicModelChoiceField

from . import NbCableEditorConfig
from .metadata_tags import available_tags
from .models import FavoriteRack, RackSavedView
from .rack_features import configured_rack_features
from .saved_view_settings import is_object_id
from .saved_views import applicable_global_views


PAGE_SIZE = 25
BULK_BATCH_SIZE = 500


class RackCatalogFilter(forms.Form):
    name = forms.CharField(required=False, max_length=100, widget=forms.TextInput(attrs={
        "class": "form-control", "placeholder": "Rack name or #ID",
    }))
    site = DynamicModelChoiceField(queryset=Site.objects.none(), label="Site", required=False)
    location = DynamicModelChoiceField(queryset=Location.objects.none(), label="Location", required=False,
                                      query_params={"site_id": "$site"})
    status = forms.ChoiceField(choices=[("", "Any status"), *RackStatusChoices], required=False,
                               widget=forms.Select(attrs={"class": "form-select no-ts"}))
    tenant = DynamicModelChoiceField(queryset=Tenant.objects.none(), label="Tenant", required=False)
    role = DynamicModelChoiceField(queryset=RackRole.objects.none(), label="Role", required=False)
    group = DynamicModelChoiceField(queryset=SiteGroup.objects.none(), label="Group (site group)", required=False)
    device_count = forms.IntegerField(required=False, min_value=0, max_value=2**31 - 1,
                                     widget=forms.NumberInput(attrs={"class": "form-control"}))
    height = forms.IntegerField(required=False, label="Height (U)", min_value=1, max_value=32767,
                                widget=forms.NumberInput(attrs={"class": "form-control"}))

    def __init__(self, data, user, db):
        super().__init__(data)
        tags = available_tags(db, user, Rack)
        self.fields["tag"] = DynamicModelChoiceField(queryset=tags, label="Tag", required=False)
        for key, model in (("site", Site), ("location", Location), ("tenant", Tenant),
                           ("role", RackRole), ("group", SiteGroup)):
            self.fields[key].queryset = model.objects.using(db).restrict(user)


class RackLookup(forms.Form):
    configure = DynamicModelChoiceField(queryset=Rack.objects.none(), label="Find a rack")

    def __init__(self, racks):
        super().__init__()
        self.fields["configure"].queryset = racks


def _rack_id(value):
    if value and len(value) <= 19 and value.isascii() and value.isdecimal():
        pk = int(value)
        if is_object_id(pk):
            return pk
    return None


def _with_device_count(racks, user):
    counts = Device.objects.using(racks.db).restrict(user).filter(rack_id=OuterRef("pk")).order_by().values("rack_id")
    counts = counts.annotate(total=Count("pk")).values("total")
    return racks.annotate(visible_device_count=Coalesce(Subquery(counts), 0))


def _filtered_racks(racks, filters, user):
    if name := filters.get("name"):
        pk = _rack_id(name[1:]) if name.startswith("#") else None
        racks = racks.filter(pk=pk) if pk else racks.filter(name__icontains=name)
    for key in ("site", "tenant", "role"):
        if item := filters.get(key):
            racks = racks.filter(**{f"{key}_id": item.pk})
    if location := filters.get("location"):
        locations = Location.objects.using(racks.db).restrict(user).filter(
            pk__in=location.get_descendants(include_self=True).values("pk"),
        )
        racks = racks.filter(location_id__in=locations.values("pk"))
    if group := filters.get("group"):
        groups = SiteGroup.objects.using(racks.db).restrict(user).filter(
            pk__in=group.get_descendants(include_self=True).values("pk"),
        )
        sites = Site.objects.using(racks.db).restrict(user).filter(group_id__in=groups.values("pk"))
        racks = racks.filter(site_id__in=sites.values("pk"))
    if status := filters.get("status"):
        racks = racks.filter(status=status)
    if tag := filters.get("tag"):
        racks = racks.filter(tags__pk=tag.pk)
    if filters.get("height") is not None:
        racks = racks.filter(u_height=filters["height"])
    racks = _with_device_count(racks, user)
    if filters.get("device_count") is not None:
        racks = racks.filter(visible_device_count=filters["device_count"])
    return racks


def _local_views(rack):
    return RackSavedView.objects.using(rack._state.db).filter(rack=rack)


def _view_choices(rack, enabled):
    choices = [("default", "Rack default"), ("personal", "Personal view")]
    if enabled:
        local = list(_local_views(rack).values_list("pk", "name", "is_default"))
        choices.extend((str(pk), f"{name} (rack default)" if default else name)
                       for pk, name, default in local)
        has_default = any(default for _, _, default in local)
        for pk, name, default in applicable_global_views(rack).values_list("pk", "name", "is_default"):
            is_default = default and not has_default
            choices.append((f"global-{pk}", f"{name} (rack default)" if is_default else f"{name} (global)"))
            has_default = has_default or is_default
    return choices


def _editor_url(rack, view=None):
    url = reverse("plugins:nbcableeditor:rack", args=[rack.pk])
    return f"{url}?{urlencode({'view': view})}" if view is not None else url


def _favorite_link(rack, key, enabled):
    if key == "personal":
        return _editor_url(rack, key), "Personal view", False
    selected = None
    if enabled and key.startswith("global-"):
        if pk := _rack_id(key.removeprefix("global-")):
            selected = applicable_global_views(rack).filter(pk=pk).values_list("name", flat=True).first()
    elif enabled and (pk := _rack_id(key)):
        selected = _local_views(rack).filter(pk=pk).values_list("name", flat=True).first()
    if selected is not None:
        return _editor_url(rack, key), selected, False
    default = None
    if enabled:
        default = _local_views(rack).filter(is_default=True).values_list("pk", flat=True).first()
        if default is None:
            global_id = applicable_global_views(rack).filter(is_default=True).values_list("pk", flat=True).first()
            if global_id is not None:
                default = f"global-{global_id}"
    return _editor_url(rack, default), "Rack default", key != "default"


def _place_names(racks, user, db):
    return (
        dict(Site.objects.using(db).restrict(user).filter(pk__in={rack.site_id for rack in racks})
             .values_list("pk", "name")),
        dict(Location.objects.using(db).restrict(user).filter(pk__in={rack.location_id for rack in racks})
             .values_list("pk", "name")),
    )


def _add_matching(favorites, matching, user):
    ids = matching.exclude(pk__in=favorites.values("rack_id")).order_by().values_list("pk", flat=True).iterator()
    with transaction.atomic(using=favorites.db):
        while batch := list(islice(ids, BULK_BATCH_SIZE)):
            favorites.bulk_create(
                [FavoriteRack(user=user, rack_id=pk) for pk in batch],
                ignore_conflicts=True,
            )


@login_required
@require_http_methods(["GET", "POST"])
@csrf_protect
def my_racks(request):
    user = request.user
    db = router.db_for_write(FavoriteRack)
    racks = Rack.objects.using(db).restrict(user)
    favorites = FavoriteRack.objects.using(db).filter(user=user)
    filters = RackCatalogFilter(request.GET, user, db)
    valid_filters = filters.is_valid()
    matching = _filtered_racks(racks, filters.cleaned_data, user) if valid_filters else racks.none()
    has_filter = valid_filters and any(value is not None and value != "" for value in filters.cleaned_data.values())
    enabled = configured_rack_features()["savedViews"]
    query = request.GET.copy()
    configure = query.pop("configure", [None])[-1]
    return_url = request.path + (f"?{query.urlencode()}" if query else "")

    if request.method == "POST":
        try:
            action = request.POST.get("action")
            if action == "add-matching":
                if not has_filter:
                    return HttpResponseBadRequest("Apply a rack filter first.")
                _add_matching(favorites, matching, user)
                messages.success(request, "Matching racks added to your list.")
            elif action in ("save", "remove"):
                pk = _rack_id(request.POST.get("rack"))
                if pk is None:
                    raise Http404
                if action == "remove":
                    favorites.filter(rack_id=pk).delete()
                    messages.success(request, "Favorite removed.")
                else:
                    rack = get_object_or_404(racks, pk=pk)
                    key = request.POST.get("view")
                    if key not in dict(_view_choices(rack, enabled)):
                        return HttpResponseBadRequest("This view is unavailable for the rack.")
                    favorites.update_or_create(user=user, rack=rack, defaults={"view_key": key})
                    messages.success(request, "Favorite saved.")
            else:
                return HttpResponseBadRequest("Choose a valid favorite action.")
        except IntegrityError:
            messages.error(request, "A rack changed while saving. Try again.")
        return redirect(return_url)

    selected = None
    if configure is not None:
        selected = get_object_or_404(racks, pk=_rack_id(configure))
    selected_key = favorites.filter(rack=selected).values_list("view_key", flat=True).first() if selected else None
    favorite_page = Paginator(
        favorites.filter(rack__in=racks).select_related("rack").order_by("rack__name", "rack_id"), PAGE_SIZE,
    ).get_page(request.GET.get("favorites_page"))
    catalog_page = Paginator(matching.order_by("name", "pk"), PAGE_SIZE).get_page(request.GET.get("page"))
    catalog_racks = list(catalog_page)
    favorite_entries = list(favorite_page)
    sites, locations = _place_names(catalog_racks + [entry.rack for entry in favorite_entries], user, db)
    links = {}
    favorite_rows = []
    for entry in favorite_entries:
        link = _favorite_link(entry.rack, entry.view_key, enabled)
        links[entry.rack_id] = link
        url, view_name, unavailable = link
        favorite_rows.append({
            "rack": entry.rack, "url": url, "view_name": view_name, "view_unavailable": unavailable,
            "site": sites.get(entry.rack.site_id), "location": locations.get(entry.rack.location_id),
        })
    existing = dict(favorites.filter(rack_id__in=[rack.pk for rack in catalog_racks]).values_list("rack_id", "view_key"))
    catalog_rows = []
    for rack in catalog_racks:
        if rack.pk in existing and rack.pk not in links:
            links[rack.pk] = _favorite_link(rack, existing[rack.pk], enabled)
        catalog_rows.append({
            "rack": rack, "site": sites.get(rack.site_id), "location": locations.get(rack.location_id),
            "favorite": rack.pk in existing, "url": links[rack.pk][0] if rack.pk in links else _editor_url(rack),
        })
    return render(request, "nbcableeditor/my_racks.html", {
        "editor_version": NbCableEditorConfig.version,
        "rack_lookup": RackLookup(racks),
        "filter_form": filters,
        "selected": selected,
        "selected_key": selected_key or "default",
        "view_choices": _view_choices(selected, enabled) if selected else [],
        "return_url": return_url,
        "favorite_page": favorite_page,
        "favorite_rows": favorite_rows,
        "catalog_page": catalog_page,
        "catalog_rows": catalog_rows,
        "can_add_matching": has_filter and matching.exclude(pk__in=favorites.values("rack_id")).exists(),
    })
