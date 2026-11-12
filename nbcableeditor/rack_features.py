from .models import CableEditorSettings


RACK_FEATURE_LABELS = {
    "viewOptions": "View options menu",
    "devices": "Device filter",
    "portRows": "Port row filter",
    "deviceCableFocus": "Device cable focus",
    "rackSides": "Rack side selector",
    "lines": "Line mode selector",
    "selectedConnections": "Manual connection selection",
    "connectionFilter": "Connection filter builder",
    "routingStrategy": "Routing strategy selector",
    "deviceImages": "Device image controls",
    "interfaceHighlight": "Interface highlighting controls",
    "vlan": "VLAN filter, colors, and details",
    "zoom": "Zoom controls",
    "gapControls": "Rack gap controls",
    "panels": "Sidebar visibility controls",
    "virtualCombine": "Virtual combine control",
    "trim": "Trim-to-ports control",
    "quickConnect": "Quick connect mode",
    "unplug": "Batch unplug mode",
    "history": "Cable history, undo, and redo",
    "planning": "Rack planning",
    "calculator": "Cable calculator",
    "export": "Export",
    "savedViews": "Saved rack views",
}

VIEW_TOOLBAR_FEATURES = tuple(key for key in RACK_FEATURE_LABELS if key != "savedViews")


def normalize_rack_flags(value, keys):
    stored = value if isinstance(value, dict) else {}
    return {key: stored.get(key) is not False for key in keys}


def configured_rack_features():
    stored = CableEditorSettings.objects.filter(pk=1).values_list("options__features", flat=True).first()
    return normalize_rack_flags(stored, RACK_FEATURE_LABELS)
