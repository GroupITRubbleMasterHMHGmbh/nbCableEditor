"""Readable inventory attributes for the rack's connection and port filters."""

from dcim.models import DeviceRole, DeviceType, Interface, Location, Manufacturer, Module, ModuleBay, ModuleType, Rack, Site
from django.db.models import Prefetch, prefetch_related_objects
from extras.models import Tag


def _records(user, model, ids, *fields, tagged=False):
    ids = set(ids) - {None}
    if not ids:
        return {}
    queryset = model.objects.restrict(user).filter(pk__in=ids).only(*fields)
    if tagged:
        queryset = queryset.prefetch_related(_tags())
    return {item.pk: item for item in queryset}


def _tags():
    return Prefetch("tags", to_attr="_rack_filter_tags")


def _named(item, field="name"):
    return {"id": item.pk, "name": getattr(item, field)} if item else None


def _choice(item, field="name"):
    return [_named(item, field)] if item else []


def _tag_choices(item, visible_tags):
    return [_named(visible_tags[tag.pk]) for tag in getattr(item, "_rack_filter_tags", ()) if tag.pk in visible_tags]


class RackFilterMetadata:
    def __init__(self, user, rack, devices, ports, *, include_trace_places=False):
        prefetch_related_objects(list(devices.values()), _tags())
        device_types = _records(user, DeviceType, (item.device_type_id for item in devices.values()),
                                "model", "manufacturer", tagged=True)
        roles = _records(user, DeviceRole, (item.role_id for item in devices.values()), "name")
        racks = _records(user, Rack, (item.rack_id for item in devices.values()), "name", "location")
        sites = _records(user, Site, {rack.site_id, *(item.site_id for item in devices.values())}, "name")
        self.site_id = rack.site_id if rack.site_id in sites else None
        self.trace_context = {}
        self.trace_places = {}
        if include_trace_places:
            locations = _records(user, Location, {
                rack.location_id, *(item.location_id for item in racks.values()),
                *(item.location_id for item in devices.values()),
            }, "name")
            if rack.location_id is None or rack.location_id in locations:
                self.trace_context["locationId"] = rack.location_id
            for pk, device in devices.items():
                place = {}
                device_rack = racks.get(device.rack_id)
                if device.rack_id is None or device_rack is not None:
                    place["rackId"] = device.rack_id
                if device_rack and (device_rack.location_id is None or device_rack.location_id in locations):
                    place["rackLocationId"] = device_rack.location_id
                if device.site_id in sites:
                    place["siteId"] = device.site_id
                # Rack location is the fallback only when the device has no assigned location.
                location_id = device.location_id or (device_rack.location_id if device_rack else None)
                location_known = device.location_id is not None or "rackId" in place
                if location_known and (location_id is None or location_id in locations):
                    place["locationId"] = location_id
                self.trace_places[pk] = {"tracePlace": place, "location": _named(locations.get(location_id))}

        modules = _records(user, Module, (item.module_id for item in ports), "module_type", "module_bay", tagged=True)
        module_types = _records(user, ModuleType, (item.module_type_id for item in modules.values()),
                                "model", "manufacturer", tagged=True)
        bays = _records(user, ModuleBay, (item.module_bay_id for item in modules.values()), "name")
        manufacturers = _records(user, Manufacturer, (
            item.manufacturer_id for item in (*device_types.values(), *module_types.values())
        ), "name")
        visible_tags = _records(user, Tag, (
            tag.pk for items in (devices, device_types, modules, module_types) for item in items.values()
            for tag in item._rack_filter_tags
        ), "name")

        self.devices = {}
        for pk, device in devices.items():
            device_type = device_types.get(device.device_type_id)
            self.devices[pk] = {
                "deviceRoles": _choice(roles.get(device.role_id)),
                "deviceTags": _tag_choices(device, visible_tags),
                "deviceTypeTags": _tag_choices(device_type, visible_tags),
                "deviceManufacturers": _choice(manufacturers.get(device_type.manufacturer_id)) if device_type else [],
                "rack": _named(racks.get(device.rack_id)),
                "site": _named(sites.get(device.site_id)),
                "outsideRack": device.rack_id != rack.pk,
            }

        self.modules = {}
        for pk, module in modules.items():
            module_type = module_types.get(module.module_type_id)
            bay = bays.get(module.module_bay_id)
            name = " · ".join(filter(None, (bay.name if bay else None, module_type.model if module_type else None)))
            self.modules[pk] = {
                "modules": [{"id": pk, "name": name or f"Module #{pk}"}],
                "moduleTypes": _choice(module_type, "model"),
                "moduleTags": _tag_choices(module, visible_tags),
                "moduleTypeTags": _tag_choices(module_type, visible_tags),
                "moduleManufacturers": _choice(manufacturers.get(module_type.manufacturer_id)) if module_type else [],
            }

    def port(self, port):
        return {
            **self.modules.get(port.module_id, {}),
            **({"interfaceId": port.pk} if isinstance(port, Interface) else {}),
        }
