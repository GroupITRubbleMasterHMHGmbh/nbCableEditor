import re

from dcim.models import Rack
from django.db import IntegrityError, OperationalError, router, transaction
from django.db.models import F, Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from .configuration import can_manage_editor_settings
from .models import GlobalRackSavedView, RackSavedView
from .rack_features import configured_rack_features
from .request_data import JsonRequestError, read_json_object
from .saved_view_settings import clean_view_settings, is_object_id


def _editable_racks(user, db):
    return Rack.objects.using(db).restrict(user, "change")


def saved_view_bootstrap(request, rack):
    user = request.user
    db = rack._state.db
    return {
        "url": reverse("plugins:nbcableeditor:rack-saved-views", args=[rack.pk]),
        "rackId": rack.pk,
        "canManage": user.is_authenticated and _editable_racks(user, db).filter(pk=rack.pk).exists(),
        "globalDesignerUrl": reverse("plugins:nbcableeditor:global-views")
        if can_manage_editor_settings(user) else None,
        "views": _rack_views_payload(rack, RackSavedView.objects.using(db).filter(rack=rack)),
    }


def _name(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 120 or re.search(r"[\x00-\x1f\x7f]", value):
        raise JsonRequestError("Enter a view name with 1 to 120 characters.", 400)
    return value.strip()


def _views_payload(views):
    return [
        {
            "id": view.pk, "name": view.name, "revision": view.revision,
            "isDefault": view.is_default, "settings": view.settings,
        }
        for view in views
    ]


def applicable_global_views(rack):
    scope = Q(all_racks=True) | Q(racks=rack) | Q(sites=rack.site_id) | Q(tags__in=rack.tags.values("pk"))
    if rack.role_id is not None:
        scope |= Q(roles=rack.role_id)
    return GlobalRackSavedView.objects.using(rack._state.db).filter(scope).distinct()


def _rack_views_payload(rack, views):
    payload = _views_payload(views)
    has_default = any(view["isDefault"] for view in payload)
    # A rack-specific default wins. Otherwise, the first applicable global default wins in view order.
    for view in applicable_global_views(rack):
        is_default = view.is_default and not has_default
        payload.append({
            "id": f"global-{view.pk}", "name": view.name, "revision": view.revision,
            "isDefault": is_default, "isGlobal": True, "settings": view.settings,
            "showInToolbar": view.show_in_toolbar,
        })
        has_default = has_default or is_default
    return payload


def _change_view(rack_id, views, data):
    action = data.get("action")
    if action not in ("create", "save", "delete"):
        raise JsonRequestError("Choose a valid rack view action.", 400)

    if action == "create":
        view = RackSavedView(rack_id=rack_id)
    else:
        if not is_object_id(data.get("id")):
            raise JsonRequestError("Choose a valid rack view.", 400)
        view = get_object_or_404(views, pk=data["id"])
        if type(data.get("revision")) is not int or data["revision"] != view.revision:
            raise JsonRequestError("This view changed. Reload the saved views and try again.", 409)
        if action == "delete":
            view_id = view.pk
            view.delete()
            return view_id, 200
        view.revision += 1

    if action == "create" or "name" in data:
        view.name = _name(data.get("name"))
    if action == "create" or "settings" in data:
        view.settings = clean_view_settings(data.get("settings"))
    if "isDefault" in data:
        if type(data["isDefault"]) is not bool:
            raise JsonRequestError("Choose whether this is the default view.", 400)
        view.is_default = data["isDefault"]
        if view.is_default:
            views.filter(is_default=True).exclude(pk=view.pk).update(is_default=False, revision=F("revision") + 1)
    view.save(using=views.db)
    return view.pk, 201 if action == "create" else 200


@require_http_methods(["GET", "POST"])
@csrf_protect
def rack_saved_views(request, pk):
    user = request.user
    db = router.db_for_write(RackSavedView)
    racks = Rack.objects.using(db).restrict(user)
    views = RackSavedView.objects.using(db).filter(rack_id=pk)
    if request.method == "GET":
        rack = get_object_or_404(racks, pk=pk)
        if not configured_rack_features()["savedViews"]:
            return JsonResponse({"error": "Saved rack views are disabled in the Cable Editor settings."}, status=403)
        return JsonResponse({"views": _rack_views_payload(rack, views)})

    try:
        if not user.is_authenticated:
            raise JsonRequestError("Sign in to manage rack views.", 403)
        get_object_or_404(racks, pk=pk)
        if not configured_rack_features()["savedViews"]:
            raise JsonRequestError("Saved rack views are disabled in the Cable Editor settings.", 403)
        editable = _editable_racks(user, db).filter(pk=pk)
        if not editable.exists():
            raise JsonRequestError("You do not have permission to manage views for this rack.", 403)
        data = read_json_object(request)
        with transaction.atomic(using=db):
            # Serialize writes even when the rack has no saved views yet.
            rack = get_object_or_404(racks.select_for_update(of=("self",), no_key=True), pk=pk)
            if not editable.exists():
                raise JsonRequestError("You do not have permission to manage views for this rack.", 403)
            view_id, status = _change_view(pk, views, data)
            return JsonResponse({"views": _rack_views_payload(rack, views), "viewId": view_id}, status=status)
    except JsonRequestError as exc:
        return JsonResponse({"error": str(exc)}, status=exc.status)
    except IntegrityError:
        return JsonResponse({"error": "That view name is already in use, or the rack changed. Reload and try again."}, status=409)
    except OperationalError as exc:
        if getattr(exc.__cause__, "sqlstate", None) not in ("40001", "40P01"):
            raise
        return JsonResponse({"error": "A concurrent edit changed the rack. Reload and try again."}, status=409)
