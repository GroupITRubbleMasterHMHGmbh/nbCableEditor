import json
import re
from decimal import Decimal
from functools import wraps

from core.signals import clear_events
from dcim.choices import LinkStatusChoices
from dcim.models import Cable, Rack
from django.core.exceptions import RequestDataTooBig, ValidationError
from django.db import IntegrityError, OperationalError, router, transaction
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_GET, require_http_methods
from utilities.conversion import to_meters
from utilities.exceptions import AbortRequest

from .cable_history import HistoryConflictError, history_for_rack
from .cable_views import CableEditError, _cable_fields, _is_object_id, _port_reference, _request_data
from .calculator import calculate_report, configured_calculator, normalize_measurements, normalize_profile, report_csv
from .models import RackCableGeometry, RackCablePlan
from .plan_apply import apply_rack_plan

MAX_OPERATIONS = 500
MAX_REQUEST_BYTES = 512 * 1024


def _geometry(rack):
    return RackCableGeometry.objects.filter(rack=rack).values_list("measurements", flat=True).first() or {}


def plan_bootstrap(request, rack):
    config = configured_calculator()
    return {
        "url": reverse("plugins:nbcableeditor:plans", args=[rack.pk]),
        "reportUrl": reverse("plugins:nbcableeditor:calculator", args=[rack.pk]),
        "canAdd": request.user.has_perm("nbcableeditor.add_rackcableplan"),
        "canMeasure": Rack.objects.restrict(request.user, "change").filter(pk=rack.pk).exists(),
        "profiles": [_profile(name, options) for name, options in config["profiles"].items()],
        "defaultProfile": config["defaultProfile"],
        "geometry": _geometry(rack),
    }


def _profile(name, options):
    return {"id": name, "name": name, "options": options}


def _plans_for(user, rack, action="view"):
    return RackCablePlan.objects.restrict(user, action).filter(rack=rack)


def _summary(plan, editable, deletable):
    return {
        "id": plan.pk, "name": plan.name, "revision": plan.revision,
        "applied": plan.applied_at is not None,
        "appliedAt": plan.applied_at.isoformat() if plan.applied_at else None,
        "canEdit": editable and plan.applied_at is None, "canDelete": deletable,
    }


def _rack_data(request, rack):
    from .views import _nbcableeditor_context

    return _nbcableeditor_context(request, rack.pk)["rack_data"]


def _rack_ports(rack_data):
    return {port["id"]: {**port, "deviceName": device["name"]}
            for device in rack_data["devices"] for port in device["ports"]}


def _visible_operations(plan, rack_data):
    ports = _rack_ports(rack_data)
    cables = {cable["id"] for cable in rack_data["cables"]}
    operations = []
    for operation in plan.operations:
        target = [operation["a"], operation["b"]] if operation["action"] != "delete" else []
        original = operation.get("before", {}).values()
        removed = plan.applied_at and operation["action"] == "delete"
        if (
            all(key in ports for key in (*target, *original))
            and (operation["action"] == "add" or removed or operation["cable_id"] in cables)
        ):
            operations.append(operation)
        else:
            operations.append({"id": operation["id"], "action": operation["action"], "restricted": True})
    return operations


def _payload(user, plan, rack_data):
    result = _summary(
        plan, _plans_for(user, plan.rack, "change").filter(pk=plan.pk).exists(),
        _plans_for(user, plan.rack, "delete").filter(pk=plan.pk).exists(),
    )
    visible_ids = {cable["id"] for cable in rack_data["cables"]}
    return {
        **result, "profile": plan.profile, "operations": _visible_operations(plan, rack_data),
        "result": {
            "ids": {key: value for key, value in plan.result.get("ids", {}).items()
                    if value is None or value in visible_ids},
            "status": plan.result["status"],
        } if plan.applied_at else None,
    }


def _name(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 120 or re.search(r"[\x00-\x1f\ud800-\udfff]", value):
        raise CableEditError("Enter a plan name with 1 to 120 characters.", 400)
    return value.strip()


def _ends(cable):
    return {"a": cable["a"], "b": cable["b"]}


def _local_cable(cable):
    return cable and cable["simple"] and all(_ends(cable).values())


def _clean_operations(user, plan, raw, rack_data):
    if not isinstance(raw, list) or len(raw) > MAX_OPERATIONS:
        raise CableEditError(f"A plan can contain up to {MAX_OPERATIONS} operations.", 400)
    ports = _rack_ports(rack_data)
    cables = {cable["id"]: cable for cable in rack_data["cables"]}
    existing = {row["cable_id"]: row for row in plan.operations if row["action"] != "add"}
    by_id = {row["id"]: row for row in plan.operations}
    visible = {row["id"] for row in _visible_operations(plan, rack_data) if not row.get("restricted")}
    seen_ids, seen_cables = set(), set()
    operations = []
    for row in raw:
        if not isinstance(row, dict):
            raise CableEditError("Invalid plan operation.", 400)
        action, operation_id = row.get("action"), row.get("id")
        if (
            action not in ("add", "move", "delete") or not isinstance(operation_id, str)
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", operation_id) or operation_id in seen_ids
        ):
            raise CableEditError("Each plan operation needs a unique identifier and a valid action.", 400)
        seen_ids.add(operation_id)
        if row.get("restricted") is True and operation_id in by_id and operation_id not in visible:
            operation = by_id[operation_id]
            cable_id = operation.get("cable_id")
            if cable_id is not None:
                if cable_id in seen_cables:
                    raise CableEditError("Each existing cable can occur only once in the plan.", 400)
                seen_cables.add(cable_id)
            operations.append(operation)
            continue

        operation = {"id": operation_id, "action": action}
        if action != "add":
            cable_id = row.get("cable_id")
            if not _is_object_id(cable_id) or cable_id in seen_cables:
                raise CableEditError("Each existing cable can occur only once in the plan.", 400)
            cable = cables.get(cable_id)
            permission = "editable" if action == "move" else "deletable"
            if not _local_cable(cable) or not cable[permission]:
                raise CableEditError("This existing cable is unavailable for that action in this rack.", 409)
            seen_cables.add(cable_id)
            before = existing[cable_id]["before"] if cable_id in existing else _ends(cable)
            if "before" in row and row["before"] != before:
                raise CableEditError("The original cable endpoints changed. Reload the rack before planning this action.", 409)
            operation.update(cable_id=cable_id, before=before)
        elif not user.has_perm("dcim.add_cable"):
            raise CableEditError("You do not have permission to add cables.", 403)

        if action != "delete":
            a, b = row.get("a"), row.get("b")
            if _port_reference(a) is None or _port_reference(b) is None or a == b:
                raise CableEditError("Choose two distinct ports for each connection.", 400)
            if a not in ports or b not in ports:
                raise CableEditError("Both ports must be readable and belong to this rack.", 404)
            operation.update(a=a, b=b)
        if action == "add":
            operation.update(_cable_fields(row))
            if operation.get("length") is not None:
                operation["length"] = str(operation["length"])
        operations.append(operation)
    return operations


def _plan_cables(plan, rack_data):
    cables = {cable["id"]: cable for cable in rack_data["cables"]}
    result = []
    for row in _visible_operations(plan, rack_data):
        if row.get("restricted") or row["action"] == "delete":
            continue
        cable = {"id": row["id"], **_ends(row)}
        if row["action"] == "move":
            cable.update({
                **cables[row["cable_id"]], **cable, "action": "move",
                "endpointA": None, "endpointB": None, "traceA": None, "traceB": None,
            })
        else:
            cable.update(action="new", typeValue=row.get("type") or "", label=row.get("label", ""),
                         color=row.get("color", ""))
            if row.get("length") is not None:
                cable["manualLengthMm"] = float(to_meters(Decimal(row["length"]), row["length_unit"]) * 1000)
        result.append(cable)
    return result


def _report(rack, rack_data, plan=None):
    if plan:
        profile, catalog = plan.profile["options"], plan.catalog
        cables = _plan_cables(plan, rack_data)
    else:
        config = configured_calculator()
        profile, catalog = config["profiles"][config["defaultProfile"]], config["catalog"]
        cables = rack_data["cables"]
    return calculate_report(rack, rack_data, cables, profile, catalog, _geometry(rack), planning=plan is not None)


def _preview(user, plan, rack_data):
    issues = []

    def issue(message, operation_id=None, severity="error"):
        issues.append({"message": message, "operationId": operation_id, "severity": severity})

    ports = _rack_ports(rack_data)
    cables = {cable["id"]: cable for cable in rack_data["cables"]}
    operations = _visible_operations(plan, rack_data)
    released = set()
    if not operations:
        issue("Add a cable change to the plan first.")
    for row in operations:
        action, operation_id = row["action"], row["id"]
        if row.get("restricted"):
            issue("An original or target endpoint is no longer available in this rack.", operation_id)
        elif action != "add":
            cable = cables[row["cable_id"]]
            permission = "editable" if action == "move" else "deletable"
            if not _local_cable(cable) or _ends(cable) != row["before"]:
                issue("The original cable endpoints changed after planning.", operation_id)
            elif not cable[permission]:
                issue("The existing cable cannot be changed or has dependent NetBox records.", operation_id)
            else:
                released.update(row["before"].values())
        elif not user.has_perm("dcim.add_cable"):
            issue("You do not have permission to add cables.", operation_id)

    targets = {}
    for row in operations:
        if row.get("restricted") or row["action"] == "delete":
            continue
        for key in _ends(row).values():
            port = ports[key]
            name = f"{port['deviceName']} / {port['name']}"
            if port["blocked"] or (port["occupancy"] != "free" and key not in released):
                issue(f"{name} is unavailable in the target state.", row["id"])
            if key in targets:
                message = f"{name} is used by more than one planned cable."
                issue(message, row["id"])
                if targets[key] is not None:
                    issue(message, targets[key])
                targets[key] = None
            else:
                targets[key] = row["id"]

    report = _report(plan.rack, rack_data, plan)
    for row in report["review"]:
        for warning in row["warnings"]:
            issue(warning, row["id"], severity="warning")
    token = None
    if not any(item["severity"] == "error" for item in issues):
        fingerprint = json.dumps([user.pk, plan.pk, plan.revision, plan.operations, report], sort_keys=True)
        token = salted_hmac("nbcableeditor.plan-preview", fingerprint, algorithm="sha256").hexdigest()
    return {"operations": operations, "issues": issues, "report": report, "token": token}


def _json_errors(view):
    @wraps(view)
    def handled(*args, **kwargs):
        try:
            return view(*args, **kwargs)
        except CableEditError as exc:
            clear_events.send(sender=Cable)
            return JsonResponse({"error": str(exc)}, status=exc.status)
        except (ValidationError, AbortRequest, HistoryConflictError) as exc:
            clear_events.send(sender=Cable)
            return JsonResponse({"error": " ".join(getattr(exc, "messages", [str(exc)]))}, status=409)
        except IntegrityError:
            clear_events.send(sender=Cable)
            return JsonResponse({"error": "The name or an endpoint is already in use, or the rack changed. Reload and try again."}, status=409)
        except OperationalError as exc:
            if getattr(exc.__cause__, "sqlstate", None) not in ("40001", "40P01"):
                raise
            clear_events.send(sender=Cable)
            return JsonResponse({"error": "A concurrent edit changed the rack. Reload and try again."}, status=409)
        except (RequestDataTooBig, RecursionError):
            return JsonResponse({"error": "The planning request is too large."}, status=413)

    return handled


def _data(request):
    if len(request.body) > MAX_REQUEST_BYTES:
        raise CableEditError("The planning request is too large.", 413)
    return _request_data(request)


def _validated(normalizer, raw, **kwargs):
    try:
        return normalizer(raw, **kwargs)
    except ValidationError as exc:
        raise CableEditError(" ".join(exc.messages), 400) from exc
    except ValueError as exc:
        raise CableEditError(str(exc), 400) from exc


def _create_plan(user, rack, **fields):
    if not user.has_perm("nbcableeditor.add_rackcableplan"):
        raise CableEditError("You do not have permission to create rack plans.", 403)
    plan = RackCablePlan.objects.create(rack=rack, **fields)
    if not (
        _plans_for(user, rack, "add").filter(pk=plan.pk).exists()
        and _plans_for(user, rack).filter(pk=plan.pk).exists()
    ):
        raise CableEditError("This plan is outside your permitted scope.", 403)
    return plan


@require_http_methods(["GET", "POST"])
@csrf_protect
@_json_errors
def rack_plans(request, pk):
    user = request.user
    rack = get_object_or_404(Rack.objects.restrict(user), pk=pk)
    if request.method == "GET":
        editable = set(_plans_for(user, rack, "change").values_list("pk", flat=True))
        deletable = set(_plans_for(user, rack, "delete").values_list("pk", flat=True))
        return JsonResponse({"plans": [_summary(plan, plan.pk in editable, plan.pk in deletable)
                                       for plan in _plans_for(user, rack).defer("operations", "profile", "catalog", "result")]})

    data = _data(request)
    action = data.get("action")
    with transaction.atomic():
        if action == "geometry":
            if not Rack.objects.restrict(user, "change").filter(pk=pk).exists():
                raise CableEditError("You do not have permission to edit rack measurements.", 403)
            geometry = _validated(normalize_measurements, data.get("geometry"))
            RackCableGeometry.objects.update_or_create(rack=rack, defaults={"measurements": geometry})
            return JsonResponse({"geometry": geometry})
        if action != "create":
            raise CableEditError("Choose a valid rack plan action.", 400)
        config = configured_calculator()
        profile_id = data.get("profileId") or config["defaultProfile"]
        if not isinstance(profile_id, str) or profile_id not in config["profiles"]:
            raise CableEditError("Choose an available calculator profile.", 400)
        plan = _create_plan(user, rack, name=_name(data.get("name")), catalog=config["catalog"],
                            profile=_profile(profile_id, config["profiles"][profile_id]))
        return JsonResponse({"plan": _payload(user, plan, {"devices": [], "cables": []})}, status=201)


@require_http_methods(["GET", "POST"])
@csrf_protect
@_json_errors
def rack_plan(request, pk, plan_id):
    user = request.user
    rack = get_object_or_404(Rack.objects.restrict(user), pk=pk)
    visible = _plans_for(user, rack)
    if request.method == "GET":
        plan = get_object_or_404(visible, pk=plan_id)
        return JsonResponse({"plan": _payload(user, plan, _rack_data(request, rack))})

    data = _data(request)
    action = data.get("action")
    db = router.db_for_write(Cable)
    with transaction.atomic(using=db):
        plan = get_object_or_404(visible.select_for_update(of=("self",)), pk=plan_id)
        permission = "delete" if action == "delete" else "change"
        if action != "duplicate" and not _plans_for(user, rack, permission).filter(pk=plan_id).exists():
            raise CableEditError("You do not have permission for this rack plan action.", 403)
        status = data.get("status", LinkStatusChoices.STATUS_PLANNED)
        if (
            action == "apply" and plan.applied_at and data.get("token") == plan.result["token"]
            and status == plan.result["status"]
        ):
            payload = _payload(user, plan, _rack_data(request, rack))
            return JsonResponse({"plan": payload, "ids": payload["result"]["ids"], "history": history_for_rack(user, pk)})
        if type(data.get("revision")) is not int or data["revision"] != plan.revision:
            raise CableEditError("This plan changed. Reload it before editing or applying.", 409)
        if action == "delete":
            plan.delete()
            return JsonResponse({"deleted": plan_id})
        if action != "duplicate" and plan.applied_at:
            raise CableEditError("This plan has already been applied. Duplicate it to make another draft.", 409)
        rack_data = _rack_data(request, rack)
        if action == "duplicate":
            operations = [] if plan.applied_at else _visible_operations(plan, rack_data)
            if any(row.get("restricted") for row in operations):
                raise CableEditError("A plan with inaccessible endpoints cannot be duplicated.", 409)
            copy = _create_plan(user, rack, name=_name(data.get("name")), profile=plan.profile,
                                catalog=plan.catalog, operations=operations)
            return JsonResponse({"plan": _payload(user, copy, rack_data)}, status=201)
        if action == "save":
            if "name" in data:
                plan.name = _name(data["name"])
            if "profile" in data:
                profile = data["profile"]
                if not isinstance(profile, dict) or "options" not in profile:
                    raise CableEditError("Enter a valid calculator profile.", 400)
                options = _validated(normalize_profile, profile["options"], strict=True)
                plan.profile = {**plan.profile, "options": options}
            if "operations" in data:
                plan.operations = _clean_operations(user, plan, data["operations"], rack_data)
            plan.revision += 1
            plan.save()
            if not _plans_for(user, rack, "change").filter(pk=plan_id).exists() or not visible.filter(pk=plan_id).exists():
                raise CableEditError("The saved plan would fall outside your permitted scope.", 403)
            return JsonResponse({"plan": _payload(user, plan, rack_data)})
        if action == "preview":
            return JsonResponse({"preview": _preview(user, plan, rack_data)})
        if action == "apply":
            preview = _preview(user, plan, rack_data)
            token = data.get("token")
            if not preview["token"] or not isinstance(token, str) or not constant_time_compare(preview["token"], token):
                return JsonResponse({"error": "The plan or rack changed. Review the changes again.", "preview": preview}, status=409)
            if status not in (LinkStatusChoices.STATUS_PLANNED, LinkStatusChoices.STATUS_CONNECTED):
                raise CableEditError("Choose Planned or Connected for new cables.", 400)
            result = apply_rack_plan(db, user, pk, plan.operations, status=status, label=f"Apply rack plan: {plan.name}")
            plan.applied_at = timezone.now()
            plan.applied_by = user
            plan.revision += 1
            plan.result = {"token": token, "ids": result["ids"], "status": status}
            plan.save()
            if not _plans_for(user, rack, "change").filter(pk=plan_id).exists() or not visible.filter(pk=plan_id).exists():
                raise CableEditError("The applied plan would fall outside your permitted scope.", 403)
            payload = _payload(user, plan, _rack_data(request, rack))
            return JsonResponse({
                "plan": payload, "ids": payload["result"]["ids"], "history": result["history"],
            })
        raise CableEditError("Choose a valid rack plan action.", 400)


@require_GET
@_json_errors
def rack_calculator(request, pk):
    rack = get_object_or_404(Rack.objects.restrict(request.user), pk=pk)
    plan_id = request.GET.get("plan")
    plan = None
    if plan_id is not None:
        if not re.fullmatch(r"[1-9][0-9]{0,18}", plan_id) or not _is_object_id(int(plan_id)):
            raise CableEditError("Choose a valid rack plan.", 400)
        plan = get_object_or_404(_plans_for(request.user, rack), pk=int(plan_id))
    report = _report(rack, _rack_data(request, rack), plan)
    if request.GET.get("format") != "csv":
        return JsonResponse({"report": report})
    kind = request.GET.get("view", "detail")
    if kind not in ("detail", "bom"):
        raise CableEditError("Choose a detail list or a bill of materials.", 400)
    response = HttpResponse(report_csv(report, kind), content_type="text/csv; charset=utf-8")
    source = f"plan-{plan.pk}" if plan else "stock"
    response["Content-Disposition"] = f'attachment; filename="rack-{pk}-{source}-{kind}.csv"'
    return response
