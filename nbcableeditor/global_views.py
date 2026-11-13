from dcim.models import (
    Cable, Device, DeviceRole, DeviceType, Interface, Manufacturer, Module, ModuleBay,
    ModuleType, Rack, RackRole, Site,
)
from django.core.exceptions import PermissionDenied
from django.db import IntegrityError, OperationalError, router, transaction
from django.db.models import Prefetch, Q
from django.db.models.functions import Lower
from django.http import Http404, JsonResponse
from django.shortcuts import render
from django.urls import reverse
from django.utils.translation import override
from django.views.decorators.clickjacking import xframe_options_sameorigin
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_GET, require_POST

from . import NbCableEditorConfig
from .configuration import ZOOM_CHOICES, ZOOM_REFERENCE_SCALE, can_manage_editor_settings
from .metadata_tags import available_tags
from .models import GlobalRackSavedView
from .rack_features import RACK_FEATURE_LABELS, TRACE_DESTINATION_FEATURES, VIEW_TOOLBAR_FEATURES, configured_rack_features
from .request_data import JsonRequestError, read_json_object
from .saved_view_settings import clean_view_settings, is_object_id
from .saved_views import _name
from .views import _nbcableeditor_context


SCOPE_KEYS = ("sites", "racks", "roles", "tags")
MAX_SCOPE_SELECTION = 1000
PREVIEW_PAGE_SIZE = 40
FILTER_CHOICE_LIMIT = 40
FILTER_LOOKUPS = {
    "devices": (Device, "name"),
    "deviceTypes": (DeviceType, "model"),
    "deviceRoles": (DeviceRole, "name"),
    "deviceManufacturers": (Manufacturer, "name"),
    "interfaces": (Interface, "name"),
    "modules": (Module, None),
    "moduleTypes": (ModuleType, "model"),
    "moduleManufacturers": (Manufacturer, "name"),
}
FILTER_TAG_TARGETS = {
    "deviceTags": Device, "deviceTypeTags": DeviceType, "moduleTags": Module, "moduleTypeTags": ModuleType,
}
FILTER_DEVICE_FIELDS = ("id", "name", "deviceType", "deviceTypeId", "filter")
FILTER_PORT_FIELDS = ("id", "kind", "name", "filter", "filterTrace", "vlanMode", "untaggedVlan", "taggedVlans")
FILTER_CABLE_FIELDS = (
    "id", "a", "b", "endpointA", "endpointB", "filterTrace", "typeValue", "lengthValue", "lengthUnit",
)


def _readable_targets(user, db):
    return {
        "sites": Site.objects.using(db).restrict(user),
        "racks": Rack.objects.using(db).restrict(user),
        "roles": RackRole.objects.using(db).restrict(user),
        "tags": available_tags(db, user, Rack),
    }


def _validated_scope(raw, targets):
    if not isinstance(raw, dict) or set(raw) - {"all", *SCOPE_KEYS} or type(raw.get("all")) is not bool:
        raise JsonRequestError("Choose all racks or select which racks can use this view.", 400)
    scope = {"all": raw["all"]}
    for key in SCOPE_KEYS:
        selection = raw.get(key, [])
        if (not isinstance(selection, list) or len(selection) > MAX_SCOPE_SELECTION
                or not all(is_object_id(pk) for pk in selection)):
            raise JsonRequestError(f"Choose at most {MAX_SCOPE_SELECTION} valid {key}.", 400)
        selected = set(selection)
        if selected and targets[key].filter(pk__in=selected).count() != len(selected):
            raise JsonRequestError("One or more selected targets are unavailable.", 403)
        scope[key] = selected if not scope["all"] else set()
    return scope


def _scope_filter(scope):
    return (
        Q(site_id__in=scope["sites"]) | Q(pk__in=scope["racks"])
        | Q(role_id__in=scope["roles"]) | Q(tags__pk__in=scope["tags"])
    )


def _preview(scope, targets, offset):
    racks = targets["racks"]
    if not scope["all"]:
        racks = racks.filter(_scope_filter(scope))
    racks = racks.order_by(Lower("name"), "pk").distinct()
    count = racks.count()
    offset = min(offset, max(0, (count - 1) // PREVIEW_PAGE_SIZE * PREVIEW_PAGE_SIZE))
    rows = list(racks.values("pk", "name", "site_id")[offset:offset + PREVIEW_PAGE_SIZE])
    sites = dict(targets["sites"].filter(pk__in={row["site_id"] for row in rows}).values_list("pk", "name"))
    return {
        "count": count, "offset": offset, "pageSize": PREVIEW_PAGE_SIZE,
        "racks": [{
            "id": row["pk"], "name": row["name"], "site": sites.get(row["site_id"], ""),
            "url": reverse("plugins:nbcableeditor:rack", args=[row["pk"]]),
        } for row in rows],
    }


def _filter_fields(record, fields):
    return {key: record[key] for key in fields if key in record}


@override("en")
def _filter_catalog(request, rack_id):
    if rack_id is None:
        destinations = {
            key: reverse(f"dcim-api:{key}-list") if request.user.has_perm(f"dcim.view_{key}") else None
            for key in ("rack", "location", "site")
        }
        return {
            "rackId": None, "siteId": None, "locationId": None,
            "devices": [], "cables": [], "filterTraceEndpoints": {}, "previewUrl": None,
            "cableTypes": [{"value": value, "label": str(label)}
                           for value, label in Cable._meta.get_field("type").flatchoices if value],
            "filterDestinationUrls": {f"{key}s": value for key, value in destinations.items()},
        }
    if not is_object_id(rack_id):
        raise JsonRequestError("Choose a valid preview rack.", 400)
    try:
        data = _nbcableeditor_context(request, rack_id)["rack_data"]
    except Http404 as exc:
        raise JsonRequestError("This preview rack is unavailable.", 404) from exc
    return {
        **_filter_fields(data, ("rackId", "siteId", "locationId", "cableTypes",
                                "filterTraceEndpoints", "filterDestinationUrls")),
        "devices": [
            {**_filter_fields(device, FILTER_DEVICE_FIELDS),
             "ports": [_filter_fields(port, FILTER_PORT_FIELDS) for port in device["ports"]]}
            for device in data["devices"]
        ],
        "cables": [_filter_fields(cable, FILTER_CABLE_FIELDS) for cable in data["cables"]],
        "previewUrl": reverse("plugins:nbcableeditor:global-views-rack-preview", args=[rack_id]),
    }


def _filter_choices(user, db, data):
    field = data.get("field")
    if not isinstance(field, str) or (field not in FILTER_LOOKUPS and field not in FILTER_TAG_TARGETS):
        raise JsonRequestError("Choose a valid filter field.", 400)
    query, ids = data.get("query", ""), data.get("ids")
    if not isinstance(query, str) or len(query) > 128:
        raise JsonRequestError("Enter a shorter filter search.", 400)
    if ids is not None and (not isinstance(ids, list) or len(ids) > FILTER_CHOICE_LIMIT
                            or not all(is_object_id(pk) for pk in ids)):
        raise JsonRequestError("Choose valid filter options.", 400)

    def readable(model):
        return model.objects.using(db).restrict(user)

    model, label_field = FILTER_LOOKUPS.get(field, (None, "name"))
    choices = readable(model) if model else available_tags(db, user, FILTER_TAG_TARGETS[field]).distinct()
    device_components = model in (Interface, Module)
    if device_components:
        choices = choices.filter(device_id__in=readable(Device).values("pk"))
    query = query.strip()
    if ids is not None:
        choices = choices.filter(pk__in=ids)
    elif query:
        condition = Q(**{f"{label_field}__icontains": query}) if label_field else Q()
        if model is Device:
            condition |= Q(asset_tag__icontains=query)
        if device_components:
            condition |= Q(device__name__icontains=query)
        if model is Module:
            condition |= Q(module_type_id__in=readable(ModuleType).filter(model__icontains=query).values("pk"))
            condition |= Q(module_bay_id__in=readable(ModuleBay).filter(name__icontains=query).values("pk"))
        if query.isascii() and query.isdecimal() and len(query) < 20 and is_object_id(int(query)):
            condition |= Q(pk=int(query))
        choices = choices.filter(condition)

    order = ("device__name",) if device_components else ()
    if label_field:
        order = (*order, Lower(label_field))
    columns = ("pk", label_field) if label_field else ("pk", "module_type_id", "module_bay_id")
    if model is Device:
        columns = (*columns, "asset_tag")
    elif device_components:
        columns = (*columns, "device__name")
    rows = list(choices.order_by(*order, "pk").values(*columns)[:FILTER_CHOICE_LIMIT + 1])
    if model is Module:
        types = dict(readable(ModuleType).filter(pk__in={row["module_type_id"] for row in rows})
                     .values_list("pk", "model"))
        bays = dict(readable(ModuleBay).filter(pk__in={row["module_bay_id"] for row in rows})
                    .values_list("pk", "name"))
    options = []
    for row in rows[:FILTER_CHOICE_LIMIT]:
        if model is Module:
            label = " · ".join(filter(None, (bays.get(row["module_bay_id"]), types.get(row["module_type_id"])))) or "Module"
        else:
            label = row[label_field] or "Device"
        if model is Device and row["asset_tag"]:
            label = f'{label} ({row["asset_tag"]})'
        if device_components and row["device__name"]:
            label = f'{row["device__name"]} · {label}'
        options.append([row["pk"], f'{label} (#{row["pk"]})'])
    return {"choices": options, "hasMore": len(rows) > FILTER_CHOICE_LIMIT}


@require_GET
@xframe_options_sameorigin
def global_view_rack_preview(request, pk):
    if not can_manage_editor_settings(request.user) or not configured_rack_features()["connectionFilter"]:
        raise PermissionDenied
    context = _nbcableeditor_context(request, pk)
    context.update(
        global_view_preview=True, rack_base_template="nbcableeditor/rack_preview_base.html",
        can_manage_editor_settings=False, cable_url="", port_url="",
    )
    data = context["rack_data"]
    data.update(globalViewPreview=True, canAdd=False, canChange=False, canDelete=False, history=None)
    for feature in ("savedViews", "history", "planning", "calculator", "export", "quickConnect", "unplug"):
        data["settings"]["features"][feature] = False
    for cable in data["cables"]:
        cable.update(editable=False, metadataEditable=False)
    for device in data["devices"]:
        for port in device["ports"]:
            port.update(metadataEditable=False, manualConnectUrl=None)
    return render(request, "nbcableeditor/rack.html", context)


def _designer_payload(views, targets):
    views = views.prefetch_related(*(
        Prefetch(key, queryset=targets[key].only("pk"), to_attr=f"_readable_{key}") for key in SCOPE_KEYS
    ))
    return [
        {
            "id": view.pk, "name": view.name, "revision": view.revision, "settings": view.settings,
            "showInToolbar": view.show_in_toolbar, "isDefault": view.is_default,
            "scope": {
                "all": view.all_racks,
                **{key: [item.pk for item in getattr(view, f"_readable_{key}")] for key in SCOPE_KEYS},
            },
        }
        for view in views
    ]


def _restricted_scope(view, key, targets):
    return set(getattr(view, key).exclude(pk__in=targets[key].values("pk")).values_list("pk", flat=True))


def _save_scope(view, scope, targets):
    # Edits can replace only the scope entries this administrator has permission to see.
    for key in SCOPE_KEYS:
        getattr(view, key).set(scope[key] | _restricted_scope(view, key, targets))
    if not scope["all"] and not any(getattr(view, key).exists() for key in SCOPE_KEYS):
        raise JsonRequestError("Select at least one site, rack, role or tag.", 400)


@require_GET
def global_view_designer(request):
    if not can_manage_editor_settings(request.user):
        raise PermissionDenied
    db = router.db_for_read(GlobalRackSavedView)
    targets = _readable_targets(request.user, db)
    choices = {key: list(targets[key].order_by(Lower("name"), "pk").values("id", "name")) for key in SCOPE_KEYS}
    rack_sites = dict(targets["racks"].values_list("pk", "site_id"))
    sites = {site["id"]: site["name"] for site in choices["sites"]}
    for rack in choices["racks"]:
        if site := sites.get(rack_sites.get(rack["id"])):
            rack["name"] = f'{rack["name"]} · {site}'
    return render(request, "nbcableeditor/global_views.html", {
        "editor_version": NbCableEditorConfig.version,
        "designer": {
            "url": reverse("plugins:nbcableeditor:global-views-api"),
            "views": _designer_payload(GlobalRackSavedView.objects.using(db), targets),
            "choices": choices,
            "zoomChoices": ZOOM_CHOICES,
            "zoomReferenceScale": ZOOM_REFERENCE_SCALE,
            "traceDestinationFeatures": TRACE_DESTINATION_FEATURES,
            "toolbarFeatures": {key: RACK_FEATURE_LABELS[key] for key in VIEW_TOOLBAR_FEATURES},
            "features": configured_rack_features(),
        },
    })


@require_POST
@csrf_protect
def global_views_api(request):
    if not can_manage_editor_settings(request.user):
        return JsonResponse({"error": "You do not have permission to manage global rack views."}, status=403)
    db = router.db_for_write(GlobalRackSavedView)
    views = GlobalRackSavedView.objects.using(db)
    try:
        data = read_json_object(request)
        action = data.get("action")
        if action in ("filter-catalog", "filter-choices"):
            if not configured_rack_features()["connectionFilter"]:
                raise JsonRequestError("The rack filter editors are disabled.", 403)
            payload = (_filter_catalog(request, data.get("rackId")) if action == "filter-catalog"
                       else _filter_choices(request.user, db, data))
            return JsonResponse(payload)
        targets = _readable_targets(request.user, db)
        if action == "preview":
            scope = _validated_scope(data.get("scope"), targets)
            offset = data.get("offset", 0)
            if type(offset) is not int or not 0 <= offset < 2**31:
                raise JsonRequestError("Choose a valid rack preview page.", 400)
            # Include unchanged targets the administrator cannot list in the selector.
            if is_object_id(data.get("id")) and not scope["all"]:
                existing = views.filter(pk=data["id"]).first()
                if existing:
                    for key in SCOPE_KEYS:
                        scope[key].update(_restricted_scope(existing, key, targets))
            return JsonResponse(_preview(scope, targets, offset))
        if action not in ("create", "save", "delete"):
            raise JsonRequestError("Choose a valid global view action.", 400)

        with transaction.atomic(using=db):
            if action == "create":
                view = GlobalRackSavedView()
            else:
                if not is_object_id(data.get("id")):
                    raise JsonRequestError("Choose a valid global view.", 400)
                view = views.select_for_update().filter(pk=data["id"]).first()
                if view is None:
                    raise JsonRequestError("This global view is no longer available.", 404)
                if type(data.get("revision")) is not int or data["revision"] != view.revision:
                    raise JsonRequestError("This global view changed. Reload and try again.", 409)
                if action == "delete":
                    view.delete()
                    return JsonResponse({"views": _designer_payload(views, targets)})
                view.revision += 1
            scope = _validated_scope(data.get("scope"), targets)
            view.name = _name(data.get("name"))
            view.settings = clean_view_settings(data.get("settings"))
            for key, field in (("showInToolbar", "show_in_toolbar"), ("isDefault", "is_default")):
                if key in data:
                    if type(data[key]) is not bool:
                        raise JsonRequestError("Choose valid toolbar and default options.", 400)
                    setattr(view, field, data[key])
            view.all_racks = scope["all"]
            view.save(using=db)
            _save_scope(view, scope, targets)
            return JsonResponse({"views": _designer_payload(views, targets), "viewId": view.pk},
                                status=201 if action == "create" else 200)
    except JsonRequestError as exc:
        return JsonResponse({"error": str(exc)}, status=exc.status)
    except IntegrityError:
        return JsonResponse({"error": "That global view name is already in use, or a scope target changed."}, status=409)
    except OperationalError as exc:
        if getattr(exc.__cause__, "sqlstate", None) not in ("40001", "40P01"):
            raise
        return JsonResponse({"error": "A concurrent edit changed the view. Reload and try again."}, status=409)
