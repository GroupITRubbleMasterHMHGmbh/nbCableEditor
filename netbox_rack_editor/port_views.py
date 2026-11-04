import json
import re

from django.core.exceptions import ValidationError
from django.db import IntegrityError, OperationalError, router, transaction
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_POST

from core.signals import clear_events
from dcim.models import Device, Rack
from utilities.exceptions import AbortRequest

from .cable_views import _is_object_id, _port_reference, port_key
from .metadata_tags import TagEditError, updated_tags, visible_tags


class PortEditError(ValueError):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


def _request_data(request):
    if request.content_type != "application/json":
        raise PortEditError("Send an application/json request.", 415)
    try:
        data = json.loads(request.body)
    except (ValueError, RecursionError):
        raise PortEditError("Invalid JSON request.", 400) from None
    if not isinstance(data, dict) or not {"label", "tags"} & data.keys():
        raise PortEditError("Choose at least one port detail to update.", 400)
    return data


def _update_port(db, user, rack_id, model, port_id, data):
    if not Rack.objects.using(db).restrict(user).filter(pk=rack_id).exists():
        raise PortEditError("Rack not found.", 404)

    visible_devices = Device.objects.using(db).restrict(user).filter(rack_id=rack_id)
    visible_ports = model.objects.using(db).restrict(user).filter(pk=port_id, device_id__in=visible_devices)
    port = visible_ports.select_for_update(of=("self",)).first()
    if port is None or visible_devices.filter(pk=port.device_id).select_for_update(no_key=True).first() is None:
        raise PortEditError("Port not found in this rack.", 404)

    editable_ports = visible_ports.restrict(user, "change")
    if not editable_ports.exists():
        raise PortEditError("You do not have permission to edit this port.", 403)

    label = data.get("label", port.label)
    if not isinstance(label, str) or len(label) > model._meta.get_field("label").max_length or re.search(
        r"[\x00\ud800-\udfff]", label,
    ):
        raise PortEditError("Enter a valid port label of at most 64 characters.", 400)
    if "expected_label" in data and (not isinstance(data["expected_label"], str) or "label" not in data):
        raise PortEditError("The expected label must be a string and accompany a label update.", 400)
    if "expected_label" in data and data["expected_label"] != port.label:
        raise PortEditError("The port label changed. Reload the rack and try again.", 409)
    if "expected_tags" in data and (not isinstance(data["expected_tags"], list) or "tags" not in data):
        raise PortEditError("The expected tags must be a list and accompany a tag update.", 400)
    tags = updated_tags(db, user, port, data["tags"], expected=data.get("expected_tags")) if "tags" in data else None

    port.snapshot()
    if label != port.label:
        port.label = label
        port.full_clean()
        port.save(using=db, update_fields=("label", "last_updated"))
    if tags is not None:
        port.tags.set(tags)
    if not editable_ports.exists():
        raise PortEditError("The resulting port is outside your permissions.", 403)
    return {"id": port_key(model, port.pk), "label": port.label, "tags": visible_tags(db, user, port)}


@require_POST
@csrf_protect
def mutate_port(request, pk):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "Sign in to edit ports."}, status=403)
    if not _is_object_id(pk):
        return JsonResponse({"error": "Rack not found."}, status=404)

    try:
        data = _request_data(request)
        reference = _port_reference(data.get("port_id"))
        if reference is None:
            raise PortEditError("Invalid port ID.", 400)
        model, port_id = reference
    except PortEditError as exc:
        return JsonResponse({"error": str(exc)}, status=exc.status)

    db = router.db_for_write(model)
    try:
        with transaction.atomic(using=db):
            payload = _update_port(db, request.user, pk, model, port_id, data)
    except Exception as exc:
        clear_events.send(sender=model)
        if isinstance(exc, (PortEditError, TagEditError)):
            return JsonResponse({"error": str(exc)}, status=exc.status)
        if isinstance(exc, (ValidationError, AbortRequest, IntegrityError)):
            return JsonResponse({"error": "NetBox rejected this port update. Reload the rack and try again."}, status=409)
        if isinstance(exc, OperationalError) and getattr(exc.__cause__, "sqlstate", None) in {"40001", "40P01"}:
            return JsonResponse({"error": "The port changed. Reload the rack and try again."}, status=409)
        raise
    return JsonResponse(payload)
