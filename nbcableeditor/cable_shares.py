import hashlib
import json
from urllib.parse import urlencode
from uuid import UUID

from django.db import IntegrityError
from django.http import JsonResponse
from django.urls import reverse
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_POST

from .models import RackCableShare
from .request_data import JsonRequestError, read_json_object
from .saved_view_settings import clean_view_settings, is_object_id


def shared_cable_view(request, rack, cables):
    if "cableView" not in request.GET:
        return None
    try:
        token = UUID(request.GET["cableView"])
    except ValueError:
        return None
    readable_ids = [cable["id"] for cable in cables]
    share = RackCableShare.objects.using(rack._state.db).filter(
        rack=rack, token=token, cable_id__in=readable_ids,
    ).values("token", "settings", "cable_id").first()
    if share:
        return {"token": str(share["token"]), "settings": share["settings"], "cableId": share["cable_id"]}
    return None


@require_POST
@csrf_protect
def create_cable_share(request, pk):
    from .views import _nbcableeditor_context

    if not request.user.is_authenticated:
        return JsonResponse({"error": "Sign in to create a cable link."}, status=403)
    try:
        data = read_json_object(request)
        cable_id = data.get("cableId")
        if not is_object_id(cable_id):
            raise JsonRequestError("Choose a cable in this rack.", 400)
        settings = clean_view_settings(data.get("settings"))
    except JsonRequestError as exc:
        return JsonResponse({"error": str(exc)}, status=exc.status)

    context = _nbcableeditor_context(request, pk)
    rack = context["rack"]
    if not any(cable["id"] == cable_id for cable in context["rack_data"]["cables"]):
        return JsonResponse({"error": "This cable is unavailable in the rack."}, status=404)
    canonical = json.dumps(settings, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    fingerprint = hashlib.sha256(canonical.encode("ascii")).hexdigest()
    try:
        share, _ = RackCableShare.objects.using(rack._state.db).get_or_create(
            rack=rack, cable_id=cable_id, fingerprint=fingerprint, defaults={"settings": settings},
        )
    except IntegrityError:
        return JsonResponse({"error": "This rack or cable changed. Refresh the editor and try again."}, status=409)
    path = reverse("plugins:nbcableeditor:rack", args=[pk])
    return JsonResponse({"url": path + "?" + urlencode({"cableView": share.token})})
