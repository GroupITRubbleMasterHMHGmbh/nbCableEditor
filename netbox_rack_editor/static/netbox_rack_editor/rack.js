(() => {
  "use strict";

  const editor = document.getElementById("re-rack-editor");
  if (!editor) return;

  const data = JSON.parse(document.getElementById("re-rack-data").textContent);
  const get = (name) => editor.querySelector("[data-" + name + "]");
  const workspace = get("workspace");
  const viewOptions = get("view-options");
  const viewSummary = get("view-summary");
  const viewConnections = get("view-connections");
  const viewDirectory = get("view-directory");
  const viewTrim = get("view-trim");
  const viewVirtualCombine = get("view-virtual-combine");
  const connectionsSection = get("connections-section");
  const directorySection = get("directory-section");
  const viewPreferencesKey = "netbox-rack-editor:view";
  const rackPreferencesKey = viewPreferencesKey + ":" + location.pathname;
  const viewPreferences = readViewPreferences(viewPreferencesKey);
  const rackPreferences = readViewPreferences(rackPreferencesKey);
  const defaultGap = 64;
  const pcbDefaultGap = 102;
  const minimumGapScale = .85;
  const deviceEdgeClearance = 25;
  const parallelCableGap = 4.5;
  const extraHorizontalGap = 5;
  const maxAutomaticGap = 140;
  const maxGap = 240;
  const gapStep = 48;
  const baseRackUnit = 40;
  const rackFaceAspect = 19 / 1.75;
  const savedGaps = new Map(Object.entries(rackPreferences.deviceGaps ?? {}).filter(
    ([, size]) => Number.isInteger(size) && size >= 0 && size <= maxGap,
  ));
  const board = get("board");
  const scroll = get("scroll");
  const unitElevation = get("unit-elevation");
  const gutter = get("gutter");
  const faceChoices = Array.from(editor.querySelectorAll("[data-rack-face-choice]"));
  const facePanels = Array.from(board.querySelectorAll("[data-rack-face-panel]"));
  const wires = get("wires");
  const lines = get("lines");
  const bundlePanel = get("bundle-panel");
  const bundlePairList = get("bundle-groups");
  const bundleCableList = get("bundle-cables");
  const bundleClear = get("bundle-clear");
  let bundleGroups = [];
  let expandedBundle = null;
  let bundlePanelKey = "";
  const routingStrategy = get("routing-strategy");
  const interfaceHighlight = get("interface-highlight");
  const deviceImages = get("device-images");
  const zoom = get("zoom");
  const status = get("status");
  const cancel = get("cancel");
  const search = get("search");
  const vlanQuery = get("vlan-query");
  const vlanKind = get("vlan-kind");
  const vlanClear = get("vlan-clear");
  const vlanStatus = get("vlan-status");
  const vlanLegend = get("vlan-legend");
  const portFill = get("port-fill");
  const vlanColorDialog = get("vlan-color-dialog");
  const vlanColorForm = get("vlan-color-form");
  const vlanColorRows = get("vlan-color-rules");
  const vlanColorFallbackEnabled = get("vlan-color-fallback-enabled");
  const vlanColorFallback = get("vlan-color-fallback");
  const vlanColorError = get("vlan-color-error");
  const vlanColors = globalThis.NetBoxRackVlanColors;
  let vlanColorSettings = vlanColors.restore(viewPreferences.vlanColors);
  const listFields = new Map();
  for (const control of editor.querySelectorAll("[data-directory-field], [data-connection-field]")) {
    const kind = control.hasAttribute("data-directory-field") ? "directory" : "connection";
    listFields.set(kind + ":" + control.dataset[kind + "Field"], control);
  }
  const listFieldsKey = "netbox-rack-editor:list-fields";
  const offImage = get("off-image");
  const directory = get("directory");
  const inspectorScroll = editor.querySelector(".re-rack-inspector-scroll");
  const cableDetail = get("cable-detail");
  const cableList = get("cable-list");
  const deviceFilter = get("device-filter");
  const deviceOptions = get("device-options");
  const deviceSummary = get("device-filter-summary");
  const deviceStatus = get("device-filter-status");
  const deviceReset = get("device-reset");
  const cableFocusClear = get("cable-focus-clear");
  const rowFilter = get("port-row-filter");
  const rowOptions = get("port-row-options");
  const rowSummary = get("port-row-summary");
  const rowStatus = get("port-row-status");
  const rowReset = get("port-row-reset");
  const quickButtons = Array.from(editor.querySelectorAll("[data-quick-mode]"));
  const quickApply = get("quick-apply");
  const quickClear = get("quick-clear");
  const quickStatus = get("quick-status");
  const quickCount = get("quick-count");
  const historyUndo = get("history-undo");
  const historyRedo = get("history-redo");
  const historyOpen = get("history-open");
  const historyDialog = get("history-dialog");
  const historyList = get("history-list");
  const historyError = get("history-error");
  const exportDialog = get("export-dialog");
  const exportForm = get("export-form");
  const exportFormat = get("export-format");
  const exportResolution = get("export-resolution");
  const exportCustom = get("export-custom");
  const exportSubmit = get("export-submit");
  const exportError = get("export-error");
  let exporting = false;
  const tooltip = get("cable-tooltip");
  const tooltipGuide = get("cable-tooltip-guide");
  const tooltipDock = get("cable-tooltip-dock");
  const guideLine = tooltipGuide.querySelector("path");
  const guideRing = tooltipGuide.querySelector("circle");
  const tooltipGeometry = globalThis.NetBoxRackTooltip;
  const createDialog = get("cable-create");
  const createForm = get("create-form");
  const cableDefaultsKey = "netbox-rack-editor:cable-defaults";
  const createError = get("create-error");
  const contextMenu = get("context-menu");
  const editDialog = get("cable-edit");
  const editForm = get("edit-form");
  const editError = get("edit-error");
  const editSubmit = get("edit-submit");
  const moveDialog = get("cable-move");
  const moveForm = get("move-form");
  const moveError = get("move-error");
  const moveSubmit = moveForm.querySelector('[type="submit"]');
  const detailsDialog = get("cable-modal");
  const detailsContent = get("modal-content");
  const portDialog = get("port-dialog");
  const portDialogContent = get("port-dialog-content");
  const deleteButton = get("modal-delete");
  const deleteConfirm = get("modal-delete-confirm");
  const deleteYes = get("modal-delete-yes");
  const deleteCancel = get("modal-delete-cancel");
  const detailsError = get("modal-error");
  const inlineEditors = new WeakMap();
  const cables = new Map(data.cables.map((cable) => [cable.id, cable]));
  const ports = new Map();
  const portIdsByDataset = new Map();
  const {group, mountedTop} = globalThis.NetBoxRackRows;
  const portRows = group(data);
  const rowByPort = new Map(portRows.flatMap(row => row.ports.map(port => [port, row.id])));
  const rowById = new Map(portRows.map(row => [row.id, row]));
  const filters = new URLSearchParams(location.search);
  const viewFilter = (name) => filters.get(name) ?? (typeof rackPreferences[name] === "string" ? rackPreferences[name] : "");
  const savedRackFace = viewFilter("face");
  let rackFace = savedRackFace === "rear" || savedRackFace === "both" ? savedRackFace : "front";
  const hiddenRows = new Set(viewFilter("hiddenRows").split(",").filter(id => rowById.has(id)));
  const requestedDevices = new Set(viewFilter("devices").split(","));
  const focusedDevices = new Set(data.devices.filter(({id}) => requestedDevices.has(String(id))).map(({id}) => id));
  let cableFocusDevice = data.devices.find(({id}) => String(id) === viewFilter("cableDevice")) ?? null;
  const markers = new Map();
  const directoryRows = [];
  const vlanMatches = new Map();
  const cableButtons = new Map();
  const photos = new Map();
  const portLabelSizes = new WeakMap();
  let elevationSpacing;
  let routingBay = 0;
  let zoomScale = 1;
  const SVG = "http://www.w3.org/2000/svg";
  const mask = document.createElementNS(SVG, "mask");
  mask.id = "re-rack-port-protection";
  mask.setAttribute("maskUnits", "userSpaceOnUse");
  const definitions = document.createElementNS(SVG, "defs");
  definitions.append(mask);
  const wireLayer = document.createElementNS(SVG, "g");
  const bundleLayer = document.createElementNS(SVG, "g");
  const sleeveLayer = document.createElementNS(SVG, "g");
  const traceLayer = document.createElementNS(SVG, "g");
  const traceMarkers = new Set();
  const traceTargets = new Set();
  const traceDevices = new Set();
  let tracePoints = [];
  const hoverLayer = document.createElementNS(SVG, "g");
  const handleLayer = document.createElementNS(SVG, "g");
  const previewLayer = document.createElementNS(SVG, "g");
  previewLayer.dataset.wirePreviews = "";
  for (const layer of [wireLayer, traceLayer, hoverLayer, handleLayer, previewLayer]) {
    layer.setAttribute("mask", "url(#" + mask.id + ")");
  }
  wires.append(definitions, bundleLayer, wireLayer, sleeveLayer, traceLayer, hoverLayer, handleLayer, previewLayer);
  let combinedRoutes = new Map();
  let cableSleeves = new Map();
  let sleeveAreas = [];
  let sleeveHover = null;
  let activeSleeves = [];
  const shownRoutes = new Map();
  const occupancyLabels = {free: "Free", cabled: "Cabled", marked: "Marked connected", other: "Other occupancy"};

  let historyData;
  let checkpoints;
  let checkpointIndex;
  readHistory(data.history ?? {cursor: 0, revision: 0, entries: []});
  const stagedDeletes = new Set();
  const stagedConnections = new Map();
  const stagedByPort = new Map();
  const maxBatchSize = 100;

  const savedQuickMode = history.state?.reRackQuickMode;
  let quickMode = modeAllowed(savedQuickMode) ? savedQuickMode : "normal";
  let quickSource = null;
  let preferredSourceDevice = null;
  let quickTargets = new Set();
  let selectedCable = null;
  let source = null;
  let pending = null;
  let createAction = null;
  let contextTrigger = null;
  let editingCable = null;
  let editInitialValues = null;
  let tooltipKey = null;
  let hoveredCable = null;
  let routes = null;
  let geometryKey = null;
  let geometryRoutes = null;
  let geometry = null;
  let previewRoute = null;
  let routingWorker = null;
  let workerUnavailable = false;
  let activeJob = null;
  let queuedJob = null;
  let drawnRoutes = null;
  let drawnMode = null;
  let drawnSelection = null;
  let gesture = null;
  let pendingPortClick = null;
  let dropTarget = null;
  let suppressClick = false;
  let busy = false;
  let frame = 0;
  let scrollFrame = 0;

  function node(tag, className, label) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (label) element.textContent = label;
    return element;
  }

  function button(className, label) {
    const element = node("button", className, label);
    element.type = "button";
    return element;
  }

  function httpUrl(value, allowRemote = false) {
    if (!value) return null;
    try {
      const url = new URL(value, document.baseURI);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      return allowRemote || url.origin === location.origin ? url.href : null;
    } catch {
      return null;
    }
  }

  function link(value, label, className) {
    const url = httpUrl(value);
    const element = node(url ? "a" : "span", className, label);
    if (url) element.href = url;
    return element;
  }

  function netboxDetailLink(url, label) {
    const element = link(url, label, "re-rack-detail-netbox-link");
    if (element instanceof HTMLAnchorElement) {
      element.target = "_blank";
      element.rel = "noopener";
      element.setAttribute("aria-label", label + " (opens in a new tab)");
    }
    return element;
  }

  function idleMessage() {
    if (!data.devices.length) return "No visible devices in this rack.";
    if (!data.canAdd && !data.canChange) return "Read only. Select a cable to inspect its endpoints.";
    return "Choose a port or inspect an existing connection.";
  }

  function announce(message, error = false) {
    status.textContent = message;
    status.toggleAttribute("data-error", error);
    status.toggleAttribute("data-idle", !error && message === idleMessage());
  }

  function describe(port) {
    return port ? port.device.name + " · " + port.name : "Endpoint outside this view";
  }

  function portState(port) {
    if (port.occupancy === "cabled") return "connected";
    return port.blocked ? "blocked" : "free";
  }

  function nativePortKind(port) {
    if (port.kind === "front-port") return "Front port";
    if (port.kind === "rear-port") return "Rear port";
    return "";
  }

  function portAdminState(port) {
    return nativePortKind(port) ? "" : port.enabled ? "Enabled" : "Disabled";
  }

  function portDisplayLabel(port) {
    return port.layoutLabel?.trim() || port.label?.trim() || port.name.match(/\d+$/)?.[0] || port.name;
  }

  function markerLabel(port) {
    const label = node("span", "re-rack-port-label", portDisplayLabel(port));
    label.setAttribute("aria-hidden", "true");
    return label;
  }

  function limitPortMarkerSize(marker, port) {
    const row = rowById.get(rowByPort.get(port.id));
    if (!row) return;
    const position = row.ports.indexOf(port.id);
    const left = ports.get(row.ports[position - 1]);
    const right = ports.get(row.ports[position + 1]);
    const horizontal = Math.min(left ? port.x - left.x : Infinity, right ? right.x - port.x : Infinity);
    const adjacentRows = [row.number - 1, row.number + 1].map(number =>
      rowById.get(row.deviceId + ":" + row.rackFace + ":" + number),
    );
    const vertical = Math.min(...adjacentRows.flatMap(neighbor => (neighbor?.ports ?? [])
      .map(id => ports.get(id))
      .filter(other => Math.abs(other.x - port.x) < .04)
      .map(other => Math.abs(other.y - port.y))));
    const limit = distance => "max(7px, calc(" + distance * 100 + "% - var(--re-rack-marker-clearance, 1px)))";
    if (Number.isFinite(horizontal)) marker.style.maxWidth = limit(horizontal);
    if (Number.isFinite(vertical)) marker.style.maxHeight = limit(vertical);
  }

  function portButton(port, marker) {
    const className = "re-rack-port re-rack-port-" + portState(port);
    const element = marker
      ? button(className + " re-rack-port-marker")
      : button(className + " btn btn-outline-secondary btn-sm");
    const adminState = portAdminState(port);
    const occupancy = occupancyLabels[port.occupancy] ?? "Unavailable";
    if (marker) {
      limitPortMarkerSize(element, port);
      updatePortVlanFill(element, port);
      const labelFrame = node("span", "re-rack-port-label-frame");
      labelFrame.append(markerLabel(port));
      element.append(labelFrame);
    } else {
      const meta = node("span", "re-rack-port-meta");
      meta.dataset.directoryValue = "status";
      meta.hidden = !listFields.get("directory:status")?.checked;
      if (adminState) {
        meta.append(node("span", "re-rack-port-badge re-rack-port-badge-" + adminState.toLowerCase(), adminState));
      }
      meta.append(node("span", "re-rack-port-badge re-rack-port-badge-" + port.occupancy, occupancy));
      element.append(node("span", "re-rack-dot"), node("span", "re-rack-port-name", port.name), meta);
    }
    const description = [describe(port), nativePortKind(port), adminState, occupancy].filter(Boolean).join(" · ");
    element.setAttribute("aria-label", description);
    element.setAttribute("aria-pressed", "false");
    element.setAttribute("aria-haspopup", "menu");
    element.dataset.port = port.id;
    element.toggleAttribute("data-port-used", port.occupancy !== "free");
    element.toggleAttribute("data-unrelated-port", dimPortForCableFocus(port));
    return element;
  }

  function placeable(port) {
    return Number.isFinite(port.x) && Number.isFinite(port.y) &&
      (port.face === "front" || port.face === "rear");
  }

  function deviceInFocus(id) {
    return !focusedDevices.size || focusedDevices.has(id);
  }

  function cableMatchesDevice(cable) {
    return !cableFocusDevice || [cable.a, cable.b].some(id => ports.get(id)?.device.id === cableFocusDevice.id);
  }

  function dimPortForCableFocus(port) {
    if (!cableFocusDevice || !port || port.device.id === cableFocusDevice.id || port.occupancy === "free") return false;
    const cable = cables.get(port.cableId);
    return !cable || !cableMatchesDevice(cable);
  }

  function portRowVisible(id) {
    return !hiddenRows.has(rowByPort.get(id));
  }

  function rackSideOfPort(id) {
    return rowById.get(rowByPort.get(id))?.rackFace;
  }

  function rackFaceVisible(face) {
    return rackFace === "both" || rackFace === face;
  }

  function portFaceVisible(id) {
    const face = rackSideOfPort(id);
    return !face || rackFaceVisible(face);
  }

  function visibleMarker(id) {
    const marker = markers.get(id);
    return marker && !marker.hidden && portFaceVisible(id) ? marker : undefined;
  }

  function cableInFocus(cable) {
    const a = ports.get(cable.a);
    const b = ports.get(cable.b);
    if ((a && !deviceInFocus(a.device.id)) || (b && !deviceInFocus(b.device.id))) return false;
    if ((a && !portRowVisible(a.id)) || (b && !portRowVisible(b.id))) return false;
    // A cable can be inspected from either side, even if only one of its markers is on screen.
    return rackFace === "both" || Boolean((a && portFaceVisible(a.id)) || (b && portFaceVisible(b.id)));
  }

  function modeAllowed(mode) {
    return mode === "normal" || (mode === "connect" && data.canAdd) || (mode === "unplug" && data.canDelete);
  }

  function stagedCount() {
    return stagedDeletes.size + stagedConnections.size;
  }

  function quickPortVisible(port) {
    return port && deviceInFocus(port.device.id) && portRowVisible(port.id) && portFaceVisible(port.id);
  }

  function cableHasPortInView(cable) {
    return quickPortVisible(ports.get(cable.a)) || quickPortVisible(ports.get(cable.b));
  }

  function quickAvailable(port) {
    return quickPortVisible(port) && !port.blocked && port.cableId === null && !stagedByPort.has(port.id);
  }

  function targetDevices(sourcePort) {
    const candidates = new Set();
    let sameDevice = false;
    for (const port of ports.values()) {
      if (port.id === sourcePort.id || !quickAvailable(port)) continue;
      if (port.device.id === sourcePort.device.id) sameDevice = true;
      else candidates.add(port.device.id);
    }
    if (!candidates.size && sameDevice) candidates.add(sourcePort.device.id);
    return candidates;
  }

  function quickPrompt() {
    if (quickMode === "unplug") return "Click a connected port to queue or cancel removal of its cable.";
    if (quickMode !== "connect") return "";
    if (!quickSource) {
      if (preferredSourceDevice !== null) {
        const device = data.devices.find(candidate => candidate.id === preferredSourceDevice);
        return "Choose the next source port on " + device.name + " or another visible device.";
      }
      return "Choose a free source port. Click a queued pair to remove it from the queue.";
    }
    if (!quickTargets.size) return describe(quickSource) + " selected. No eligible target is visible.";
    const target = quickTargets.size === 1
      ? data.devices.find(device => quickTargets.has(device.id)).name : "a highlighted device";
    return describe(quickSource) + " selected. Choose a free target port on " + target + ".";
  }

  function announceQuick(message = quickPrompt(), error = false) {
    quickStatus.hidden = !message;
    quickStatus.textContent = message;
    quickStatus.toggleAttribute("data-error", error);
  }

  function warnStagedNavigation(event) {
    event.preventDefault();
    event.returnValue = true;
  }

  function updateQuickControls() {
    const count = stagedCount();
    const active = quickMode !== "normal";
    board.dataset.cableMode = quickMode;
    for (const control of quickButtons) {
      const mode = control.dataset.quickMode;
      control.setAttribute("aria-pressed", String(mode === quickMode));
      control.classList.toggle("active", mode === quickMode);
      control.disabled = busy || !modeAllowed(mode);
    }
    quickApply.hidden = quickClear.hidden = !active;
    quickApply.disabled = busy || !count;
    quickClear.disabled = busy || (!count && !quickSource);
    quickCount.hidden = !count;
    quickCount.textContent = count + " queued";
    historyUndo.disabled = busy || count > 0 || checkpointIndex <= 0;
    historyRedo.disabled = busy || count > 0 || checkpointIndex < 0 || checkpointIndex >= checkpoints.length - 1;
    historyOpen.disabled = busy;
    if (count) window.addEventListener("beforeunload", warnStagedNavigation);
    else window.removeEventListener("beforeunload", warnStagedNavigation);
  }

  function refreshQuickView() {
    quickTargets = quickSource ? targetDevices(quickSource) : new Set();
    if (preferredSourceDevice !== null && !Array.from(ports.values()).some(port =>
      port.device.id === preferredSourceDevice && quickAvailable(port)
    )) preferredSourceDevice = null;
    for (const element of editor.querySelectorAll("[data-port]")) {
      const id = portIdsByDataset.get(element.dataset.port);
      element.classList.toggle("re-rack-quick-add", stagedByPort.has(id));
      element.classList.toggle("re-rack-quick-remove", stagedDeletes.has(ports.get(id)?.cableId));
      element.classList.toggle("re-rack-quick-source", quickSource?.id === id);
    }
    for (const card of board.querySelectorAll("[data-rack-device]")) {
      const id = Number(card.dataset.rackDevice);
      card.classList.toggle("re-rack-quick-device-source", (quickSource?.device.id ?? preferredSourceDevice) === id);
      card.classList.toggle("re-rack-quick-device-target", quickTargets.has(id));
    }
    for (const control of cableButtons.values()) control.disabled = quickMode !== "normal";
    updateMarks();
    updateQuickControls();
    announceQuick();
  }

  function changeQuickMode(mode) {
    if (busy || !modeAllowed(mode) || quickMode === mode) return;
    finishPortClick();
    if (stagedCount()) {
      announceQuick("Apply or clear the queued changes before switching modes.", true);
      return;
    }
    quickMode = mode;
    quickSource = null;
    preferredSourceDevice = null;
    clearViewInteraction();
    updateCableDetail();
    history.replaceState({...history.state, reRackQuickMode: quickMode}, "");
    refreshQuickView();
  }

  function queueUnplug(port) {
    const cable = cables.get(port.cableId);
    if (!cable?.deletable || !cableInFocus(cable) || !ports.has(cable.a) || !ports.has(cable.b)) {
      announceQuick("Choose a port on an editable cable within the current device and row filters.", true);
      return;
    }
    if (!stagedDeletes.delete(cable.id)) {
      if (stagedCount() >= maxBatchSize) {
        announceQuick("Apply these 100 changes before queuing more.", true);
        return;
      }
      stagedDeletes.add(cable.id);
    }
    const stroke = wireLayer.querySelector('[data-wire-visual="' + cable.id + '"]');
    stroke?.classList.toggle("re-rack-wire-staged-unplug", stagedDeletes.has(cable.id));
    refreshQuickView();
  }

  function queueConnection(port) {
    if (quickSource?.id === port.id) {
      quickSource = null;
    } else if (!quickSource && stagedByPort.has(port.id)) {
      const operation = stagedByPort.get(port.id);
      stagedConnections.delete(operation.source);
      stagedByPort.delete(operation.source);
      stagedByPort.delete(operation.target);
    } else if (!quickAvailable(port)) {
      announceQuick("Choose a free port that is not already queued.", true);
      return;
    } else if (stagedCount() >= maxBatchSize) {
      announceQuick("Apply these 100 changes before queuing more.", true);
      return;
    } else if (!quickSource) {
      quickSource = port;
    } else {
      if (!quickTargets.has(port.device.id)) {
        announceQuick("Choose a free target port on a highlighted device.", true);
        return;
      }
      const operation = {source: quickSource.id, target: port.id, cable_id: null};
      stagedConnections.set(operation.source, operation);
      stagedByPort.set(operation.source, operation);
      stagedByPort.set(operation.target, operation);
      preferredSourceDevice = quickSource.device.id;
      quickSource = null;
    }
    refreshQuickView();
  }

  function clearQuickQueue() {
    quickSource = null;
    preferredSourceDevice = null;
    stagedDeletes.clear();
    for (const stroke of wireLayer.querySelectorAll(".re-rack-wire-staged-unplug")) {
      stroke.classList.remove("re-rack-wire-staged-unplug");
    }
    stagedConnections.clear();
    stagedByPort.clear();
    refreshQuickView();
  }

  function applyQuickQueue() {
    if (busy || !stagedCount()) return;
    const deletes = Array.from(stagedDeletes, cable_id => ({action: "delete", cable_id}));
    save({action: "batch", operations: [...deletes, ...stagedConnections.values()]});
  }

  function readHistory(snapshot) {
    historyData = snapshot;
    checkpoints = [{sequence: 0, label: "Initial state"}, ...snapshot.entries].sort((a, b) => a.sequence - b.sequence);
    checkpointIndex = checkpoints.findIndex(entry => entry.sequence === snapshot.cursor);
  }

  function navigateHistory(target) {
    if (busy || stagedCount() || target === undefined || target === historyData.cursor) return;
    save({action: "history", target, revision: historyData.revision}, historyDialog.open ? historyError : null);
  }

  function showHistory() {
    if (busy) return;
    setError(historyError, stagedCount() ? "Apply or clear the queued changes before restoring a checkpoint." : "");
    const entries = document.createDocumentFragment();
    for (const checkpoint of checkpoints) {
      const current = checkpoint.sequence === historyData.cursor;
      const entry = button("re-rack-history-entry" + (current ? " re-rack-history-current" : ""));
      entry.dataset.historyTarget = checkpoint.sequence;
      entry.disabled = current || stagedCount() > 0;
      if (current) entry.setAttribute("aria-current", "step");
      entry.append(node("span", "fw-semibold", checkpoint.label || "Checkpoint " + checkpoint.sequence));
      if (checkpoint.timestamp) {
        const stamp = new Date(checkpoint.timestamp);
        const text = Number.isNaN(stamp.valueOf()) ? checkpoint.timestamp : stamp.toLocaleString("en");
        const time = node("time", "text-muted small", text);
        time.dateTime = checkpoint.timestamp;
        entry.append(time);
      }
      entry.addEventListener("click", () => navigateHistory(checkpoint.sequence));
      entries.append(entry);
    }
    historyList.replaceChildren(entries);
    historyDialog.showModal();
  }

  function adjacentDeviceBoundaries(mounted) {
    const boundaries = [];
    let occupiedEnd = -Infinity;
    let physicalEnd;
    for (const {device, top, physicalTop} of [...mounted].sort((a, b) => a.top - b.top)) {
      // A gap may only start where no device on either visible face straddles it.
      if (top === occupiedEnd) boundaries.push({top, key: physicalEnd + ":" + physicalTop, controls: []});
      if (top + device.height > occupiedEnd) {
        occupiedEnd = top + device.height;
        physicalEnd = physicalTop + device.height;
      }
    }
    return boundaries;
  }

  function virtualGapSize(gap) {
    const base = board.dataset.routingStrategy === "pcb" ? pcbDefaultGap : defaultGap;
    return savedGaps.get(gap.key) ?? Math.min(maxAutomaticGap, base + Math.round(Math.max(0, routingBay - 32) / 2));
  }

  function gapControl(gap, location) {
    const group = node("div", "re-rack-gap-control");
    group.dataset.rackGap = gap.key;
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Virtual gap " + location);
    const minus = button("", "−");
    const plus = button("", "+");
    for (const [control, direction, action] of [[minus, -1, "Decrease"], [plus, 1, "Increase"]]) {
      control.dataset.gapStep = direction;
      control.setAttribute("aria-label", action + " virtual gap " + location);
      control.addEventListener("click", () => {
        if (busy || gesture) return;
        const size = virtualGapSize(gap);
        const next = Math.max(0, Math.min(maxGap, size + gapStep * direction));
        if (next === size) return;
        savedGaps.set(gap.key, next);
        hideWireTooltip();
        applyElevationSpacing();
        invalidateRoutes();
        saveRackPreferences();
      });
    }
    group.append(minus, plus);
    gap.controls.push({group, minus, plus});
    return group;
  }

  function defaultElevationGapsVisible(scale) {
    return cables.size > 0 || elevationSpacing.focused || scale > 1 || board.dataset.routingStrategy === "pcb";
  }

  function applyElevationSpacing(print = false) {
    if (!elevationSpacing) return;
    const {gaps, rows, cards} = elevationSpacing;
    const defaultsVisible = defaultElevationGapsVisible(zoomScale);
    const printGap = print ? Math.max(16, Math.min(96, 300 / gaps.length)) : 0;
    const beforeRow = new Map();
    const insideRow = new Map();
    let extraHeight = 0;
    for (const gap of gaps) {
      const active = print || defaultsVisible || savedGaps.has(gap.key);
      const base = virtualGapSize(gap);
      const size = (defaultsVisible || savedGaps.has(gap.key) ? base * Math.max(minimumGapScale, zoomScale) : 0) + printGap;
      if (active) {
        if (Number.isInteger(gap.top)) beforeRow.set(gap.top, size);
        else insideRow.set(Math.floor(gap.top), size);
      }
      for (const {group, minus, plus} of gap.controls) {
        group.hidden = !active;
        group.style.top = "calc(var(--re-rack-unit) * " + gap.top + " + " + extraHeight + "px)";
        group.style.setProperty("--re-rack-gap-size", size + "px");
        minus.disabled = base <= 0;
        plus.disabled = base >= maxGap;
      }
      extraHeight += size;
      gap.offsetAfter = extraHeight;
    }
    board.style.setProperty("--re-rack-extra-height", extraHeight + "px");
    for (const {index, tick} of rows) {
      tick.style.setProperty("--re-rack-row-before", (beforeRow.get(index) ?? 0) + "px");
      tick.style.setProperty("--re-rack-row-inside", (insideRow.get(index) ?? 0) + "px");
      tick.toggleAttribute("data-rack-gap-controls", insideRow.has(index));
    }
    for (const {top, card} of cards) {
      const offset = gaps.findLast(gap => gap.top <= top)?.offsetAfter ?? 0;
      card.style.setProperty("--re-device-offset", offset + "px");
    }
  }

  function styleRackArtworkText(element, item, scale) {
    element.textContent = item.text;
    if (item.color) element.style.color = item.color;
    element.style.fontFamily = item.font;
    element.style.fontSize = "calc(var(--re-rack-artwork-scale, 1) * " + item.size * scale + "px)";
  }

  function renderRackRectangle(element, item, scale) {
    element.classList.add("re-rack-rectangle-frame");
    element.style.backgroundColor = item.color || (item.borderColor ? "transparent" : "#43566b");
    if (item.borderColor) element.style.setProperty("--re-rack-rectangle-border", item.borderColor);
    if (item.label?.text?.trim()) {
      const label = node("span", "re-rack-rectangle-label");
      label.dataset.labelPosition = item.label.position;
      const text = node("span", "re-rack-rectangle-label-text");
      styleRackArtworkText(text, item.label, scale);
      label.append(text);
      element.append(label);
    }
  }

  function renderRackArtwork(container, design, scale = 1) {
    for (const item of design?.items ?? []) {
      const element = node("div", "re-rack-artwork-item re-rack-artwork-" + item.kind);
      element.style.left = (item.x * 100) + "%";
      element.style.top = (item.y * 100) + "%";
      if (item.kind === "text") {
        styleRackArtworkText(element, item, scale);
      } else {
        element.style.width = (item.width * 100) + "%";
        element.style.height = (item.height * 100) + "%";
        if (item.kind === "rectangle") renderRackRectangle(element, item, scale);
        if (item.kind === "bay") {
          const module = item.module;
          const url = module?.useImage && httpUrl(module.image, true);
          if (url) {
            const image = node("img", "re-rack-module-image");
            image.alt = "";
            image.src = url;
            element.append(image);
          }
          renderRackArtwork(element, module, scale * item.width);
          const name = module ? item.name + " · " + module.name : item.name;
          element.append(node("span", "re-rack-module-label", name));
        }
      }
      container.append(element);
    }
  }

  function drawElevations() {
    invalidateRoutes();
    const startingUnit = data.startingUnit ?? 1;
    const mounted = [];
    for (const device of data.devices) {
      if (!deviceInFocus(device.id)) continue;
      const top = mountedTop(data, device);
      if (top !== null && (device.fullDepth || rackFaceVisible(device.face))) mounted.push({device, top});
    }

    // Both faces use the same physical-to-visible row map, including any half-unit offsets.
    const rows = Array.from({length: data.height}, (_, row) => row).filter((row) =>
      !focusedDevices.size || mounted.some(({device, top}) => row < top + device.height && row + 1 > top)
    );
    const compactIndex = new Map(rows.map((row, index) => [row, index]));
    const projected = mounted.map(({device, top}) => {
      const row = Math.floor(top);
      return {device, top: compactIndex.get(row) + (top - row), physicalTop: top};
    });
    const gaps = adjacentDeviceBoundaries(projected);
    const rowNumber = row => startingUnit + (data.descUnits ? row : data.height - row - 1);
    const rowCount = Math.max(1, rows.length);
    elevationSpacing = {gaps, rows: [], cards: [], focused: focusedDevices.size > 1 && mounted.length > 1};
    board.style.setProperty("--re-rack-height", rowCount);
    markers.clear();
    photos.clear();

    function appendRows(elevation, numbered = false) {
      for (const [index, row] of rows.entries()) {
        const tick = node("div", "re-rack-row");
        if (numbered) {
          const label = node("span", "", String(rowNumber(row)));
          label.dataset.rackUnitLabel = "";
          tick.append(label);
        }
        elevationSpacing.rows.push({index, tick});
        elevation.append(tick);
      }
    }

    unitElevation.replaceChildren();
    unitElevation.parentElement.hidden = !rows.length;
    appendRows(unitElevation, true);
    for (const gap of gaps) {
      const lower = rowNumber(rows[Math.floor(gap.top)]);
      const location = Number.isInteger(gap.top)
        ? "between U " + rowNumber(rows[gap.top - 1]) + " and U " + lower
        : "within U " + lower;
      unitElevation.append(gapControl(gap, location));
    }

    for (const face of ["front", "rear"]) {
      const elevation = editor.querySelector('[data-elevation="' + face + '"]');
      elevation.replaceChildren();
      if (!rackFaceVisible(face)) continue;
      if (!rows.length) {
        elevation.append(node("p", "re-rack-elevation-empty text-muted small m-0 p-2",
          "No selected devices are mounted on this side."));
        continue;
      }
      appendRows(elevation);

      for (const {device, top} of projected) {
        if (device.face !== face && !device.fullDepth) continue;
        const side = device.face === face ? "front" : "rear";
        const card = node("div", "re-rack-device");
        card.dataset.routeObstacle = device.id + ":" + face;
        card.dataset.rackDevice = device.id;
        card.style.setProperty("--re-device-top", top);
        card.style.setProperty("--re-device-height", device.height);
        elevationSpacing.cards.push({top, card});
        const label = link(device.url, device.name, "re-rack-device-name");
        label.title = device.name;
        const tools = node("div", "re-rack-device-tools");
        const focus = button("re-rack-cable-focus-button");
        focus.dataset.cableFocusDevice = device.id;
        focus.setAttribute("aria-label", "Show only cables from this device: " + device.name);
        focus.title = "Show only cables from this device";
        focus.setAttribute("aria-pressed", String(device === cableFocusDevice));
        focus.append(node("i", "mdi mdi-filter-variant"));
        focus.firstChild.setAttribute("aria-hidden", "true");
        focus.addEventListener("click", () => setCableFocus(device === cableFocusDevice ? null : device));
        tools.append(focus, label);
        const photo = node("div", "re-rack-photo");
        const design = device.design?.[side];
        const photoUrl = httpUrl(device[side + "Image"], true);
        let image = null;
        if (photoUrl) {
          image = node("img");
          image.alt = "";
          image.draggable = false;
          image.toggleAttribute("data-layout-image-hidden", design?.useImage === false);
          image.addEventListener("load", invalidateRoutes);
          image.addEventListener("error", invalidateRoutes);
          image.src = photoUrl;
          photo.append(image);
        }
        renderRackArtwork(photo, design);
        photos.set(card, {photo, image});
        for (const rawPort of device.ports) {
          const port = ports.get(rawPort.id);
          if (port.face !== side || !placeable(port)) continue;
          const marker = portButton(port, true);
          marker.hidden = !portRowVisible(port.id);
          marker.style.left = (port.x * 100) + "%";
          marker.style.top = (port.y * 100) + "%";
          photo.append(marker);
          markers.set(port.id, marker);
        }
        card.append(photo, tools);
        elevation.append(card);
      }
    }
    applyElevationSpacing();
  }

  function restoreListFields() {
    try {
      const saved = JSON.parse(localStorage.getItem(listFieldsKey));
      for (const [key, control] of listFields) {
        if (typeof saved?.[key] === "boolean") control.checked = saved[key];
      }
    } catch {
      // Browser preferences are optional.
    }
  }

  function listField(kind, key, label, value) {
    const field = node("span", "re-rack-" + kind + "-field");
    field.dataset[kind + "Value"] = key;
    field.hidden = !listFields.get(kind + ":" + key)?.checked;
    field.append(node("span", "re-rack-list-meta-label", label + " "), value);
    return field;
  }

  function appendListField(container, kind, key, label, value) {
    if (value) container.append(listField(kind, key, label, value));
  }

  function endpointPort(endpoint) {
    return {
      ...endpoint, id: endpoint.portId, name: endpoint.portName, url: endpoint.portUrl,
      device: {
        name: endpoint.deviceName, deviceType: endpoint.deviceType,
        rackName: endpoint.rackName, url: endpoint.deviceUrl,
      },
    };
  }

  function cableEndpoint(cable, end) {
    const local = ports.get(cable[end.toLowerCase()]);
    const remote = cable["endpoint" + end];
    return local ?? (remote ? endpointPort(remote) : null);
  }

  function listEndpointName(port) {
    return describe(port) + (port?.device.rackName ? " · Rack " + port.device.rackName : "");
  }

  function appendEndpointLinks(container, port) {
    container.append(netboxDetailLink(port.device.url, port.device.name), " · ", netboxDetailLink(port.url, port.name));
    if (port.device.rackName) container.append(" · Rack " + port.device.rackName);
  }

  function vlanText(port) {
    if (!port) return "";
    const label = vlan => vlan.name ? vlan.vid + " (" + vlan.name + ")" : String(vlan.vid);
    const values = [];
    if (port.untaggedVlan) values.push("Untagged " + label(port.untaggedVlan));
    if (port.taggedVlans?.length) values.push("Tagged " + port.taggedVlans.map(label).join(", "));
    if (port.vlanMode === "tagged-all") values.push("Tagged all");
    if (port.vlanMode === "q-in-q") values.push("Q-in-Q");
    if (!values.length && port.vlanMode === "access") values.push("Access");
    if (!values.length && port.vlanMode === "tagged") values.push("Tagged mode");
    return values.join(" · ");
  }

  function updatePortVlanFill(marker, port) {
    const color = vlanColors.fill(port.untaggedVlan, vlanColorSettings);
    if (color) marker.style.setProperty("--re-port-vlan-color", color);
    else marker.style.removeProperty("--re-port-vlan-color");
  }

  function applyPortFill() {
    const changed = editor.dataset.portFill !== portFill.value;
    editor.dataset.portFill = portFill.value;
    for (const [id, marker] of markers) updatePortVlanFill(marker, ports.get(id));
    if (changed) invalidateRoutes();
  }

  function addVlanColorRule(entry, focus = false) {
    const row = get("vlan-color-rule-template").content.firstElementChild.cloneNode(true);
    const ids = row.querySelector("[data-vlan-color-ids]");
    ids.value = entry?.ids ?? "";
    row.querySelector("[data-vlan-color-value]").value = entry?.color ?? "#22c55e";
    row.querySelector("[data-vlan-color-remove]").addEventListener("click", () => {
      const next = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      (next?.querySelector("[data-vlan-color-ids]") ?? get("vlan-color-add")).focus();
    });
    vlanColorRows.append(row);
    if (focus) ids.focus();
  }

  function openVlanColorSettings() {
    hideWireTooltip();
    viewOptions.open = false;
    vlanColorRows.replaceChildren();
    for (const entry of vlanColorSettings.rules) addVlanColorRule(entry);
    vlanColorFallbackEnabled.checked = Boolean(vlanColorSettings.fallback);
    vlanColorFallback.value = vlanColorSettings.fallback || "#ef4444";
    vlanColorFallback.disabled = !vlanColorFallbackEnabled.checked;
    setError(vlanColorError);
    vlanColorDialog.showModal();
  }

  function saveVlanColorSettings(event) {
    event.preventDefault();
    const rules = [];
    for (const row of vlanColorRows.children) {
      const ids = row.querySelector("[data-vlan-color-ids]");
      const color = row.querySelector("[data-vlan-color-value]");
      try {
        rules.push(vlanColors.rule(ids.value, color.value));
      } catch (error) {
        setError(vlanColorError, error.message);
        ids.focus();
        return;
      }
    }
    vlanColorSettings = {rules, fallback: vlanColorFallbackEnabled.checked ? vlanColorFallback.value : ""};
    portFill.value = "vlan";
    applyPortFill();
    saveViewPreferences();
    vlanColorDialog.close();
  }

  function listCableColor(cable) {
    const color = cableHex(cable).toUpperCase();
    const entry = node("span", "re-rack-list-color");
    if (color) {
      const swatch = node("span", "re-rack-swatch");
      swatch.style.backgroundColor = color;
      swatch.setAttribute("aria-hidden", "true");
      entry.append(swatch);
    }
    entry.append(cableColorLabel(color));
    return entry;
  }

  function drawDirectory() {
    directoryRows.length = 0;
    const fragment = document.createDocumentFragment();
    for (const device of data.devices) {
      const group = node("div", "re-rack-directory-device");
      const heading = node("h3", "re-rack-directory-heading");
      heading.append(link(device.url, device.name));
      if (device.layoutUrl) {
        heading.append(link(device.layoutUrl, "Port layout", "re-rack-layout-link"));
      }
      const list = node("div", "re-rack-directory-ports");
      const entries = device.ports.map(({id}) => {
        const port = ports.get(id);
        const entry = node("div", "re-rack-directory-entry");
        entry.dataset.portDirectoryId = id;
        const element = portButton(port, false);
        const details = node("div", "re-rack-directory-details");
        const cable = cables.get(port.cableId);
        let peerName = "";
        if (cable) {
          const peer = cableEndpoint(cable, cable.a === id ? "B" : "A");
          peerName = listEndpointName(peer);
          const peerLine = node("span", "re-rack-directory-peer");
          peerLine.append(node("span", "re-rack-list-meta-label", "Peer "), peerName);
          details.append(peerLine, listCableColor(cable));
          appendListField(details, "directory", "peer-vlan", "Peer VLAN", vlanText(peer));
        } else if (port.occupancy === "cabled") {
          details.append(node("span", "re-rack-directory-peer", "Connection details unavailable"));
        }
        appendListField(details, "directory", "vlan", "VLAN", vlanText(port));
        const type = [nativePortKind(port), port.type].filter(Boolean).join(" · ");
        appendListField(details, "directory", "type", "Type", type);
        appendListField(details, "directory", "label", "Label", port.label);
        appendListField(details, "directory", "description", "Description", port.description);
        const badge = node("span", "re-rack-vlan-badge");
        badge.hidden = true;
        details.append(badge);
        details.id = "re-rack-directory-details-" + id;
        element.setAttribute("aria-describedby", details.id);
        entry.append(element, details);
        list.append(entry);
        const searchText = [port.name, port.label, port.description, peerName].filter(Boolean).join(" ").toLowerCase();
        return {port, entry, badge, searchText};
      });
      if (!entries.length) list.append(node("span", "text-muted small", "No visible ports."));
      group.append(heading, list);
      directoryRows.push({device, group, entries});
      fragment.append(group);
    }
    fragment.append(node("p", "text-muted small mb-0", "No matching ports."));
    directory.replaceChildren(fragment);
    filterDirectory();
  }

  function filterDirectory() {
    const query = search.value.trim().toLowerCase();
    const vid = vlanId();
    let matches = false;
    for (const {device, group, entries} of directoryRows) {
      if (!deviceInFocus(device.id)) {
        group.hidden = true;
        continue;
      }
      const deviceMatches = device.name.toLowerCase().includes(query);
      let hasVisible = false;
      for (const {port, entry, badge, searchText} of entries) {
        const match = vlanMatches.get(port.id);
        markVlanMatch(entry, match, badge, vid);
        entry.hidden = !portRowVisible(port.id) || !portFaceVisible(port.id) ||
          (offImage.checked && markers.has(port.id)) ||
          (!deviceMatches && !searchText.includes(query)) || (vid !== null && !match);
        hasVisible ||= !entry.hidden;
      }
      group.hidden = entries.length || vid !== null ? !hasVisible : !deviceMatches;
      matches ||= !group.hidden;
    }
    directory.lastElementChild.hidden = matches;
  }

  function cableHex(cable) {
    const color = cable.color?.replace(/^#/, "");
    return /^[0-9a-f]{6}$/i.test(color ?? "") ? "#" + color : "";
  }

  function cableColorLabel(color) {
    if (!color) return "No color set";
    const name = createForm.querySelector('[data-color-value="' + color + '"]')?.getAttribute("aria-label");
    return name ? name + " · " + color : color;
  }

  function cableColor(cable) {
    const color = cableHex(cable);
    if (color) return color;
    // Use the same automatic HSL colors as before, represented as sRGB hex.
    const hue = ((cable.id * 137.508) % 360) / 60;
    const lightness = .52;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * .72;
    const second = chroma * (1 - Math.abs(hue % 2 - 1));
    const rgb = [
      [chroma, second, 0], [second, chroma, 0], [0, chroma, second],
      [0, second, chroma], [second, 0, chroma], [chroma, 0, second],
    ][Math.floor(hue)];
    return "#" + rgb.map(channel =>
      Math.round(255 * (channel + lightness - chroma / 2)).toString(16).padStart(2, "0")
    ).join("");
  }

  function cableStrokes(stroke, color, cableId) {
    const path = stroke.getAttribute("d");
    const rim = wire(path, "re-rack-wire-rim");
    rim.dataset.wireRim = cableId;
    const [r, g, b] = [1, 3, 5].map(offset => {
      const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    const luminance = .2126 * r + .7152 * g + .0722 * b;
    // The extra contrast stroke keeps very light or dark cables visible against the page.
    const tone = luminance > .30 ? "light" : luminance < .14 ? "dark" : null;
    if (!tone) return [rim, stroke];
    const outline = wire(path, "re-rack-wire-contrast re-rack-wire-contrast-" + tone);
    outline.dataset.wireContrast = cableId;
    return [rim, outline, stroke];
  }

  function cableName(cable) {
    return cable.label || "Cable #" + cable.id;
  }

  function canMove(cable) {
    return !!(data.canChange && cable?.editable && ports.has(cable.a) && ports.has(cable.b));
  }

  function drawCableList() {
    cableList.replaceChildren();
    cableButtons.clear();
    for (const cable of cables.values()) {
      if (!cableMatchesDevice(cable) || !cableHasPortInView(cable)) continue;
      const name = cableName(cable);
      const row = button("btn btn-outline-secondary btn-sm re-rack-cable-button");
      const heading = node("span", "re-rack-connection-name", name);
      heading.append(listCableColor(cable));
      const endpoints = node("span", "re-rack-connection-endpoints");
      endpoints.id = "re-rack-connection-endpoints-" + cable.id;
      const fields = node("span", "re-rack-connection-fields");
      for (const end of ["A", "B"]) {
        const port = cableEndpoint(cable, end);
        const endpoint = node("span", "re-rack-connection-end");
        endpoint.append(node("span", "re-rack-list-meta-label", end + " "), listEndpointName(port));
        endpoints.append(endpoint);
        appendListField(fields, "connection", "vlan", end + " VLAN", vlanText(port));
      }
      for (const [key, label] of [
        ["type", "Type"], ["status", "Status"], ["length", "Length"], ["profile", "Profile"],
        ["description", "Description"],
      ]) appendListField(fields, "connection", key, label, cable[key]);
      const badge = node("span", "re-rack-vlan-badge");
      badge.hidden = true;
      row.append(heading, endpoints, fields, badge);
      row.dataset.cableListId = cable.id;
      row.setAttribute("aria-label", name);
      row.setAttribute("aria-describedby", endpoints.id);
      row.setAttribute("aria-pressed", "false");
      row.setAttribute("aria-haspopup", "menu");
      row.addEventListener("click", () => openCableDetails(cable));
      cableButtons.set(cable.id, row);
      cableList.append(row);
    }
    cableList.append(node("p", "text-muted small mb-0"));
    filterCableList();
  }

  function vlanId() {
    const text = vlanQuery.value.trim();
    const vid = Number(text);
    return /^\d{1,4}$/.test(text) && vid >= 1 && vid <= 4094 ? vid : null;
  }

  function markVlanMatch(element, match, badge, vid) {
    element.classList.toggle("re-rack-vlan-match", Boolean(match));
    if (match) element.dataset.vlanMatch = match;
    else delete element.dataset.vlanMatch;
    if (!badge) return;
    badge.hidden = !match;
    if (match) {
      const kind = {tagged: "Tagged", untagged: "Untagged", both: "Tagged and untagged"}[match];
      badge.textContent = kind + " · VLAN " + vid;
    }
  }

  function filterCableList() {
    const vid = vlanId();
    const active = vid !== null;
    let count = 0;
    for (const [id, row] of cableButtons) {
      const cable = cables.get(id);
      const a = vlanMatches.get(cable.a);
      const b = vlanMatches.get(cable.b);
      const match = a && b && a !== b ? "both" : a || b;
      markVlanMatch(row, match, row.querySelector(".re-rack-vlan-badge"), vid);
      row.hidden = active && !match;
      if (!row.hidden) count++;
    }
    get("cable-count").textContent = count;
    const empty = cableList.lastElementChild;
    empty.hidden = count > 0;
    if (!count) {
      empty.textContent = active ? "No connections match this VLAN in the current view."
        : "No visible connections in this rack view.";
    }
    if (exportDialog.open && !exporting) updateExportOptions();
  }

  function visibleExportCableIds() {
    return [...new Set([
      ...Array.from(wireLayer.querySelectorAll("[data-wire-visual]"), path => Number(path.dataset.wireVisual)),
      ...collapsedBundleGroups().flatMap(group => group.ids),
    ])].filter(id => cableButtons.get(id)?.hidden === false);
  }

  function collapsedBundleGroups() {
    return lines.value === "bundles" && !expandedBundle ? bundleGroups : [];
  }

  function exportEndpoint(cable, end) {
    const port = cableEndpoint(cable, end);
    if (!port) return null;
    const deviceId = port.device.id ?? port.deviceId;
    return {
      deviceKey: deviceId == null ? null : "device:" + deviceId,
      deviceName: port.device.name,
      portName: port.name,
      rackName: port.device.rackName,
      side: rackSideOfPort(port.id),
    };
  }

  function exportCableRows(ids, references) {
    return ids.map(id => {
      const cable = cables.get(id);
      const color = cableHex(cable);
      return {
        id, reference: references.get(id), a: exportEndpoint(cable, "A"), b: exportEndpoint(cable, "B"),
        label: cable.label, type: cable.type, status: cable.status, length: cable.length,
        color: color || cableColor(cable), colorLabel: color ? cableColorLabel(color.toUpperCase()) : "",
      };
    });
  }

  function exportLongestEdge() {
    return Number(exportResolution.value === "custom" ? exportCustom.value : exportResolution.value);
  }

  function updateExportOptions() {
    const png = exportFormat.value === "png";
    const custom = png && exportResolution.value === "custom";
    get("export-print-options").hidden = png;
    get("export-image-options").hidden = !png;
    get("export-custom-field").hidden = !custom;
    exportCustom.disabled = !custom;
    exportSubmit.textContent = png ? "Download PNG" : "Print / Save as PDF";
    if (png) {
      const size = globalThis.NetBoxRackExport.measure(board);
      const result = !custom || exportCustom.validity.valid
        ? globalThis.NetBoxRackExport.dimensions(size, exportLongestEdge()) : null;
      get("export-dimensions").textContent = result ? result.width + " × " + result.height + " px" : "";
    } else {
      const count = visibleExportCableIds().length;
      get("export-count").textContent = count + (count === 1 ? " cable represented" : " cables represented") +
        " in the plan and matching the current filters.";
    }
  }

  function refreshExportDrawing() {
    if (frame) cancelAnimationFrame(frame);
    routes = null;
    drawWires();
    if (geometry === activeJob || geometry === queuedJob) {
      // Export must include the routes even if the background calculation is still in flight.
      routes = geometryRoutes = computeRoutes(geometry);
      drawWires();
    }
  }

  function printRackSnapshot(references, bundleRefs) {
    const displayed = new Set([...wireLayer.querySelectorAll("[data-wire-visual]")].map(path => Number(path.dataset.wireVisual)));
    const groups = collapsedBundleGroups();
    const bundled = new Set(groups.flatMap(group => group.ids));
    if (!displayed.size && !bundled.size) return globalThis.NetBoxRackExport.snapshot(board);
    const bay = Math.min(80, 38 + displayed.size + groups.length);
    const scrollLeft = scroll.scrollLeft;
    const scrollTop = scroll.scrollTop;
    board.removeAttribute("data-trimmed");
    const width = board.getBoundingClientRect().width;
    board.style.setProperty("--re-rack-print-width", (width + 2 * bay) + "px");
    board.style.setProperty("--re-rack-print-bay", bay + "px");
    board.dataset.printPlan = "";
    try {
      applyElevationSpacing(true);
      const job = measureRouting(cable => displayed.has(cable.id) || bundled.has(cable.id), "pcb");
      const origin = wires.getBoundingClientRect();
      const titles = Array.from(board.querySelectorAll(".re-rack-device-name"), title => relativeRect(title, origin));
      const paths = computeRoutes({...job, connections: job.connections.filter(({id}) => displayed.has(id)),
        spacing: 12, horizontalSpacing: 12 + extraHorizontalGap});
      const printGroups = globalThis.NetBoxRackBundles.group(job.connections.filter(({id}) => bundled.has(id)));
      for (const id of displayed) {
        if (paths.has(id)) continue;
        const cable = cables.get(id);
        const from = [cable.a, cable.b].find(port => visibleMarker(port));
        if (from !== undefined) paths.set(id, stubPoints(from, visibleMarker(from), job.protectedAreas));
      }
      const combined = planVirtualTubes(job, paths);
      return globalThis.NetBoxRackExport.snapshot(board, drawing => {
        const svg = drawing.querySelector("[data-wires]");
        const definitions = svg.querySelector("defs");
        const printMask = definitions.querySelector("mask");
        updatePortMask(job.bounds, job.portRects.values(), printMask);
        const pathsLayer = document.createElementNS(SVG, "g");
        pathsLayer.setAttribute("mask", "url(#" + printMask.id + ")");
        svg.replaceChildren(definitions, pathsLayer);
        if (printGroups.length) {
          const printBundles = document.createElementNS(SVG, "g");
          svg.insertBefore(printBundles, pathsLayer);
          globalThis.NetBoxRackBundles.draw(printBundles, printGroups, job.obstacles, job.bounds, {
            describe: bundleName, protectedAreas: job.protectedAreas, deviceClearance: job.deviceClearance,
            label: group => bundleRefs.has(group.key) ? bundleRefs.get(group.key) + " · " + group.ids.length : String(group.ids.length),
          });
        }
        for (const [id, points] of paths) {
          const cable = cables.get(id);
          const hasA = job.endpoints.has(cable.a);
          const hasB = job.endpoints.has(cable.b);
          const stub = !hasA || !hasB;
          const shape = stub ? cableShape(points, hasA ? cable.a : cable.b, undefined, job)
            : displayedCableShape(cable, points, job, combined.paths);
          const color = cableColor(cable);
          const stroke = wire(shape.d, "re-rack-wire re-rack-wire-print", color);
          stroke.style.stroke = color;
          stroke.dataset.wireVisual = id;
          const strokes = [wire(shape.d, "re-rack-wire-print-casing"), ...cableStrokes(stroke, color, id)];
          if (stub) {
            for (const line of strokes) line.classList.add("re-rack-wire-print-stub");
          }
          pathsLayer.append(...strokes);
        }
        if (combined.tubes.length) {
          const sleeves = document.createElementNS(SVG, "g");
          drawVirtualSleeves(sleeves, combined.tubes);
          svg.append(sleeves);
        }
        for (const element of drawing.querySelectorAll(".re-rack-trace-target-highlight, .re-rack-trace-end-highlight, .re-rack-trace-device-highlight")) {
          element.classList.remove("re-rack-trace-target-highlight", "re-rack-trace-end-highlight", "re-rack-trace-device-highlight");
          delete element.dataset.traceTargetStatus;
        }
        if (references.size) globalThis.NetBoxRackPrintLabels.draw(svg, {
          ...job.bounds, obstacles: [...job.protectedAreas, ...titles], references,
        });
      });
    } finally {
      delete board.dataset.printPlan;
      board.style.removeProperty("--re-rack-print-width");
      board.style.removeProperty("--re-rack-print-bay");
      applyElevationSpacing();
      fitPhotos();
      scroll.scrollTo(scrollLeft, scrollTop);
    }
  }

  async function exportRackPlan(event) {
    event.preventDefault();
    if (exporting) return;
    const png = exportFormat.value === "png";
    const longest = exportLongestEdge();
    const paper = get("export-paper").value;
    const orientation = get("export-orientation").value;
    const includeCables = get("export-cables").checked;
    const controls = [...exportForm.querySelectorAll("select, input, button:not([type='submit'])")]
      .filter(control => !control.disabled);
    exporting = true;
    controls.forEach(control => { control.disabled = true; });
    exportSubmit.disabled = true;
    exportSubmit.textContent = "Preparing…";
    setError(exportError);
    try {
      await document.fonts.ready;
      await Promise.all([...board.querySelectorAll(".re-rack-photo img")].map(image => image.decode().catch(() => {})));
      hideWireTooltip();
      refreshExportDrawing();
      const ids = visibleExportCableIds();
      const references = new Map(includeCables ? ids.toSorted((a, b) => a - b).map((id, index) => [id, index + 1]) : []);
      const bundleRefs = new Map();
      if (includeCables && !png) {
        collapsedBundleGroups().forEach((group, index) => {
          const ref = "B" + (index + 1);
          bundleRefs.set(group.key, ref);
          group.ids.forEach((id, position) => references.set(id, ref + "-" + (position + 1)));
        });
      }
      const snapshot = await (png ? globalThis.NetBoxRackExport.snapshot(board) : printRackSnapshot(references, bundleRefs));
      const title = editor.querySelector("h1").textContent.trim();
      if (png) {
        const blob = await globalThis.NetBoxRackExport.png(snapshot, longest);
        const url = URL.createObjectURL(blob);
        const download = document.createElement("a");
        download.href = url;
        download.download = (title.replace(/[<>:"/\\|?*]/g, "-") || "Rack") + " - Rack plan.png";
        download.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        exportDialog.close();
      } else {
        const summary = {front: "Front elevation", rear: "Rear elevation", both: "Front and rear elevations"}[rackFace];
        const printable = await globalThis.NetBoxRackExportPrint.prepare(snapshot, {
          title, summary, paper, orientation, cables: includeCables ? exportCableRows(ids, references) : null,
        });
        printable.focus();
        printable.print();
        exportDialog.close();
      }
    } catch (error) {
      setError(exportError, error.message || "The rack plan could not be exported.");
    } finally {
      exporting = false;
      controls.forEach(control => { control.disabled = false; });
      exportSubmit.disabled = false;
      updateExportOptions();
    }
  }

  function refreshVlanMatches() {
    const vid = vlanId();
    const raw = vlanQuery.value.trim();
    const kind = vlanKind.value;
    vlanMatches.clear();
    let freeUntagged = 0;
    if (vid !== null) {
      for (const port of ports.values()) {
        if (!quickPortVisible(port)) continue;
        const tagged = kind !== "untagged" && port.taggedVlans?.some(vlan => vlan.vid === vid);
        const untagged = kind !== "tagged" && port.untaggedVlan?.vid === vid;
        if (!tagged && !untagged) continue;
        vlanMatches.set(port.id, tagged && untagged ? "both" : tagged ? "tagged" : "untagged");
        if (untagged && port.enabled && !port.blocked && port.cableId === null) freeUntagged++;
      }
    }
    for (const [id, marker] of markers) markVlanMatch(marker, vlanMatches.get(id));
    vlanClear.hidden = !raw && kind === "any";
    if (vlanLegend) vlanLegend.hidden = vid === null;
    if (raw && vid === null) vlanQuery.setAttribute("aria-invalid", "true");
    else vlanQuery.removeAttribute("aria-invalid");
    if (vid === null) {
      vlanStatus.textContent = raw ? "Enter a VLAN ID from 1 to 4094." : "";
      return;
    }
    const count = vlanMatches.size;
    vlanStatus.textContent = count + (count === 1 ? " port" : " ports") + " with VLAN " + vid +
      (kind !== "tagged" ? " · " + freeUntagged + " free and enabled untagged" : "");
  }

  function applyVlanFilter() {
    hideWireTooltip();
    refreshVlanMatches();
    filterDirectory();
    filterCableList();
    if (lines.value === "bundles") {
      drawnMode = null;
      scheduleDraw();
    }
    persistViewFilters();
  }

  function cableTraces(cable) {
    return [["A", cable?.traceA], ["B", cable?.traceB]].filter(([, trace]) => trace);
  }

  function traceStatus(trace) {
    if (trace.active === false) {
      if (trace.status === "open") return "Open · inactive path";
      if (trace.status === "complete") return "Inactive path";
    }
    return {
      complete: "Connected",
      open: "Unpatched",
      restricted: "Further path not visible",
      split: "Path branches here",
      unsupported: "Further path unavailable",
      truncated: "Trace continues in NetBox",
    }[trace.status];
  }

  function traceTarget(trace) {
    return trace?.hops.length > 1 ? trace.hops.at(-1) : null;
  }

  function traceChain(trace, end, compact) {
    const {hops} = trace;
    const chain = node("ol", "re-rack-trace-chain");
    chain.dataset.traceDirection = end;
    const stops = [];
    const limit = hops.length - Number(compact);
    for (let i = Number(compact); i < limit; i++) {
      const hop = hops[i];
      const role = i === 0 ? "source" : i === hops.length - 1 ? "target" : "via";
      const stop = node("li", "re-rack-trace-stop");
      stop.dataset.traceRole = role;
      const device = node("span", "re-rack-trace-device");
      const connectors = node("span", "re-rack-trace-port");
      device.append(compact ? hop.deviceName : netboxDetailLink(hop.deviceUrl, hop.deviceName));
      connectors.append(compact ? hop.portName : netboxDetailLink(hop.portUrl, hop.portName));
      const next = hops[i + 1];
      // After a physical lead, NetBox lists the two sides of a passive mapping consecutively.
      if (i % 2 === 1 && i + 1 < Math.min(limit, hops.length - 1) &&
          hop.kind !== "interface" && next.kind !== "interface") {
        connectors.append(" → ", compact ? next.portName : netboxDetailLink(next.portUrl, next.portName));
        i++;
      }
      stop.append(device, connectors);
      stops.push(stop);
    }
    if (compact && stops.length > 3) {
      const more = node("li", "re-rack-trace-stop", (stops.length - 2) + " more stops");
      more.dataset.traceRole = "more";
      chain.append(stops[0], more, stops.at(-1));
    } else {
      chain.append(...stops);
    }
    return chain;
  }

  function traceSection(trace, end, compact = false) {
    const section = node("div", "re-rack-trace");
    if (compact) section.dataset.tooltipTrace = "";
    const heading = node("div", "re-rack-trace-heading");
    heading.append(node("span", "re-rack-trace-title", compact ? "Via" : "Cable trace"));
    if (!compact) heading.append(node("span", "re-rack-trace-status", traceStatus(trace)));
    const chain = traceChain(trace, end, compact);
    if (compact && !chain.childElementCount) return null;
    section.append(heading, chain);
    return section;
  }

  function renderCableTrace(cable) {
    const traces = cableTraces(cable);
    if (!traces.length) return null;
    const group = node("div");
    for (const [end, trace] of traces) group.append(traceSection(trace, end));
    return group;
  }

  function updateCableDetail() {
    cableDetail.replaceChildren();
    cableDetail.hidden = !selectedCable;
    cableDetail.className = "re-rack-cable-detail";
    for (const [id, element] of cableButtons) {
      element.setAttribute("aria-pressed", String(selectedCable?.id === id));
      element.classList.toggle("active", selectedCable?.id === id);
    }
    if (!selectedCable) return;

    const cable = selectedCable;
    const header = link(cable.url, cableName(cable), "fw-semibold");
    const detail = node("div", "text-muted small", cable.status || "Cable");
    cableDetail.append(header, detail);
    for (const [side, portId] of [["A", cable.a], ["B", cable.b]]) {
      const port = ports.get(portId);
      const row = node("div", "re-rack-cable-end");
      const label = side + " · " + (port
        ? describeCableEnd(portId) : listEndpointName(cableEndpoint(cable, side)));
      const marker = visibleMarker(portId);
      if (marker) {
        const locate = button("btn btn-link btn-sm p-0 text-start", label);
        locate.addEventListener("click", () => locateMarker(marker));
        row.append(locate);
      } else {
        row.append(node("span", "small", label));
        appendShowSide(row, portId, cable);
      }
      if (canMove(cable) && !port.blocked && portRowVisible(portId) && portFaceVisible(portId)) {
        const move = button("btn btn-outline-secondary btn-sm", "Move " + side);
        move.setAttribute("aria-label", "Move " + describe(port));
        move.addEventListener("click", () => chooseSource(port));
        row.append(move);
      }
      cableDetail.append(row);
    }
    const trace = renderCableTrace(cable);
    if (trace) cableDetail.append(trace);
    if (!canMove(cable)) {
      cableDetail.append(node("span", "text-muted small", "Moving an end is unavailable in this editor."));
    }
  }

  function describeCableEnd(portId) {
    const face = rackSideOfPort(portId);
    return describe(ports.get(portId)) + (face ? " · Rack " + face : "");
  }

  function appendShowSide(container, portId, cable) {
    const port = ports.get(portId);
    const face = rackSideOfPort(portId);
    if (!port || !face || rackFaceVisible(face) || !deviceInFocus(port.device.id) || !portRowVisible(portId)) return;
    const show = button("btn btn-outline-secondary btn-sm", face === "rear" ? "Show Rear" : "Show Front");
    show.addEventListener("click", () => {
      if (busy) return;
      const navigate = () => {
        applyRackFace(face);
        requestAnimationFrame(() => {
          const marker = visibleMarker(portId);
          if (marker) locateMarker(marker);
        });
      };
      if (detailsDialog.open) closeDetails(detailsDialog, navigate);
      else {
        navigate();
        selectCable(cable);
      }
    });
    container.append(show);
  }

  function setError(element, message = "") {
    element.textContent = message;
    element.hidden = !message;
  }

  function showDeleteConfirm(show) {
    deleteConfirm.hidden = !show;
    deleteButton.hidden = show || !selectedCable?.deletable;
    if (show) deleteCancel.focus();
  }

  function tagChip(tag, remove) {
    const chip = node("span", "re-rack-inline-tag", tag.name);
    if (/^[0-9a-f]{6}$/i.test(tag.color)) chip.style.setProperty("--re-rack-inline-tag-color", "#" + tag.color);
    if (remove) {
      const control = button("", "×");
      control.setAttribute("aria-label", "Remove tag " + tag.name);
      control.addEventListener("click", remove);
      chip.append(control);
    }
    return chip;
  }

  function displayedTags(tags) {
    if (!tags?.length) return "None shown";
    const list = node("div", "re-rack-inline-tag-list");
    list.append(...tags.map(tag => tagChip(tag)));
    return list;
  }

  function mountInlineEditor(dialog, kind, entity, persist) {
    const cable = kind === "cable";
    const template = get(cable ? "cable-inline-template" : "port-inline-template");
    const form = template.content.firstElementChild.cloneNode(true);
    const field = name => form.elements.namedItem(name);
    const status = form.querySelector("[data-inline-status]");
    const error = form.querySelector("[data-inline-error]");
    const retry = form.querySelector("[data-inline-retry]");
    const discard = form.querySelector("[data-inline-discard]");
    const tagList = form.querySelector("[data-inline-tag-list]");
    const tagSelect = form.querySelector("[data-inline-tag-select]");
    const picker = form.querySelector("[data-inline-color-picker]");
    const options = new Map((data.availableTags?.[kind] ?? []).map(tag => [tag.id, tag]));
    const fields = cable ? ["label", "color", "length", "description", "comments", "tags"] : ["label", "tags"];
    const queued = new Set();
    let chosen;
    let running = null;

    function report(message = "") {
      setError(error, message);
      retry.hidden = discard.hidden = !message;
    }

    function renderTags() {
      tagList.replaceChildren(...Array.from(chosen.values(), tag => tagChip(tag, () => {
        chosen.delete(tag.id);
        renderTags();
        tagSelect.focus();
        queue(["tags"]);
      })));
      if (!chosen.size) tagList.textContent = "None shown";
      tagSelect.replaceChildren(new Option("Add a tag…", ""));
      for (const tag of options.values()) if (!chosen.has(tag.id)) tagSelect.add(new Option(tag.name, tag.id));
      tagSelect.disabled = tagSelect.options.length === 1;
      if (tagSelect.disabled) tagSelect.options[0].textContent = "No tags to add";
    }

    const tagIds = tags => Array.from(tags, tag => tag.id).sort((a, b) => a - b);

    function restore() {
      field("label").value = entity.label ?? "";
      if (cable) {
        field("color").value = cableHex(entity).toUpperCase();
        picker.value = cableHex(entity) || "#64748B";
        field("length").value = entity.lengthValue ?? "";
        field("length_unit").value = entity.lengthUnit || "m";
        field("description").value = entity.description ?? "";
        field("comments").value = entity.comments ?? "";
      }
      chosen = new Map((entity.tags ?? []).map(tag => [tag.id, tag]));
      renderTags();
    }

    function patchFor(keys) {
      const patch = {};
      for (const key of keys) {
        if (key === "tags") {
          const tags = tagIds(chosen.values());
          const expected = tagIds(entity.tags ?? []);
          if (tags.join(",") !== expected.join(",")) Object.assign(patch, {tags, expected_tags: expected});
        } else if (key === "length") {
          const length = field("length");
          if (!length.validity.valid) throw new Error("Enter a valid cable length with up to two decimal places.");
          const values = cableLengthValues(form);
          const comparable = value => value == null ? null : Number(value);
          if (comparable(values.length) !== comparable(entity.lengthValue) || values.length_unit !== (entity.lengthUnit || null)) {
            Object.assign(patch, values);
          }
        } else {
          const value = key === "color" ? field(key).value.trim().replace(/^#/, "").toUpperCase() : field(key).value;
          if (key === "color" && value && !/^[0-9A-F]{6}$/.test(value)) throw new Error("Enter a six-digit hex color, for example #2563EB.");
          const previous = entity[key] ?? "";
          if (value !== (key === "color" ? previous.toUpperCase() : previous)) patch[key] = value;
        }
      }
      if (!cable && Object.hasOwn(patch, "label")) patch.expected_label = entity.label ?? "";
      return patch;
    }

    async function drain() {
      let saved = false;
      while (queued.size) {
        const keys = [...queued];
        queued.clear();
        try {
          const patch = patchFor(keys);
          if (!Object.keys(patch).length) continue;
          report();
          status.textContent = "Saving…";
          await persist(patch);
          if (Object.hasOwn(patch, "color") && field("color").value.trim().replace(/^#/, "").toUpperCase() === patch.color) {
            picker.value = cableHex(entity) || "#64748B";
          }
          saved = true;
        } catch (failure) {
          for (const key of keys) queued.add(key);
          status.textContent = "Unsaved";
          report(failure.message || "The change could not be saved.");
          return false;
        }
      }
      report();
    if (saved) status.textContent = "Saved";
    else if (status.textContent === "Unsaved") status.textContent = "";
      return true;
    }

    function queue(keys) {
      for (const key of keys) queued.add(key);
      if (!running) running = Promise.resolve().then(drain).finally(() => { running = null; });
      return running;
    }

    const fieldKey = input => input.name === "length_unit" ? "length" : input.name;
    form.addEventListener("focusout", event => {
      const key = fieldKey(event.target);
      if (!fields.includes(key)) return;
      if (key === "length" && form.querySelector("[data-inline-length]").contains(event.relatedTarget)) return;
      queue([key]);
    });
    form.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      const key = fieldKey(event.target);
      if (!fields.includes(key) || (key === "comments" && !event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      queue([key]);
    });
    form.addEventListener("submit", event => event.preventDefault());
    tagSelect.addEventListener("change", () => {
      const tag = options.get(Number(tagSelect.value));
      if (!tag) return;
      chosen.set(tag.id, tag);
      renderTags();
      queue(["tags"]);
    });
    retry.addEventListener("click", () => queue([]));
    discard.addEventListener("click", () => {
      queued.clear();
      restore();
      report();
      status.textContent = "Unsaved changes discarded";
      field("label").focus();
    });
    if (cable) {
      for (const unit of data.cableLengthUnits) field("length_unit").add(new Option(unit.label, unit.value));
      field("length_unit").addEventListener("change", () => queue(["length"]));
      function setColor(color) {
        field("color").value = color;
        picker.value = color || "#64748B";
        queue(["color"]);
      }
      picker.addEventListener("change", () => setColor(picker.value));
      form.addEventListener("click", event => {
        const swatch = event.target.closest("[data-inline-color-choice]");
        if (swatch) setColor(swatch.dataset.inlineColorChoice);
      });
    }
    restore();
    inlineEditors.set(dialog, {flush: () => queue(fields)});
    return form;
  }

  async function closeDetails(dialog, after) {
    if (busy || (inlineEditors.has(dialog) && !await inlineEditors.get(dialog).flush())) return;
    if (!dialog.open) return;
    dialog.close();
    after?.();
  }

  function cableDetailTaggedVlans(port) {
    if (port.vlanMode === "tagged-all") return "All VLANs";
    const vlans = port.taggedVlans ?? [];
    if (!vlans.length) return "None shown";
    const list = node("div", "re-rack-tooltip-vlan-list");
    const fill = () => list.append(...vlans.map(vlan => vlanChip(vlan)));
    if (vlans.length <= 6) {
      fill();
      return list;
    }
    const disclosure = node("details", "re-rack-detail-vlan-disclosure");
    disclosure.append(node("summary", "", vlans.length + " VLANs"), list);
    disclosure.addEventListener("toggle", () => {
      if (disclosure.open && !list.childElementCount) fill();
    });
    return disclosure;
  }

  function portDetailFields(port, includePhysicalDetails = false) {
    const values = [["Port type", port.type || nativePortKind(port) || "Not set"]];
    if (!nativePortKind(port)) {
      values.push(
        ["Untagged VLAN", port.untaggedVlan ? vlanChip(port.untaggedVlan, true) : "None shown"],
        ["Tagged VLANs", cableDetailTaggedVlans(port)],
        ["VLAN mode", port.vlanModeDisplay || port.vlanMode || "Not set"],
        ["PoE", portPoeText(port)],
      );
      if (typeof port.enabled === "boolean") values.push(["Port state", portAdminState(port)]);
      if (includePhysicalDetails) {
        if (port.speedKbps != null) values.push(["Speed", new Intl.NumberFormat("en").format(port.speedKbps / 1000) + " Mbit/s"]);
        if (port.duplex) values.push(["Duplex", port.duplex]);
        if (port.mtu != null) values.push(["MTU", String(port.mtu)]);
        if (port.managementOnly) values.push(["Purpose", "Management only"]);
      }
    }
    if (port.description) values.push(["Description", port.description]);

    const fields = node("dl", "re-rack-detail-port-fields");
    for (const [label, value] of values) {
      const detail = node("dd");
      detail.append(value);
      fields.append(node("dt", "", label), detail);
    }
    return fields;
  }

  function cableRouteEndpoint(cable, end, portId) {
    const endpoint = node("div", "re-rack-detail-endpoint");
    endpoint.setAttribute("role", "group");
    endpoint.setAttribute("aria-label", "End " + end);
    const badge = node("span", "re-rack-detail-end-badge", end);
    badge.setAttribute("aria-hidden", "true");
    endpoint.append(badge);

    const port = cableEndpoint(cable, end);
    if (!port) {
      endpoint.append(node("p", "re-rack-detail-position", describe(port)));
      return endpoint;
    }

    const {device} = port;
    const deviceName = node("p", "re-rack-detail-device");
    deviceName.append(netboxDetailLink(device.url, device.name));
    endpoint.append(deviceName);
    if (device.deviceType) endpoint.append(node("p", "re-rack-detail-model", device.deviceType));
    const interfaceLabel = port.label?.trim();
    const interfaceName = node("p", "re-rack-detail-interface");
    interfaceName.append(netboxDetailLink(port.url, port.name));
    if (interfaceLabel && interfaceLabel !== port.name) interfaceName.append(" · " + interfaceLabel);
    endpoint.append(interfaceName);
    const location = [];
    const local = ports.has(portId);
    if (local) {
      const side = rackSideOfPort(portId);
      if (side) location.push(side === "front" ? "Rack Front" : "Rack Rear");
      if (mountedTop(data, device) !== null) {
        location.push("U " + device.position);
        if (!side) location.push("Port not placed on rack image");
      } else {
        location.push("Device not mounted");
      }
    } else {
      location.push(data.devices.some(candidate => candidate.id === port.deviceId) ? "Port not placed on rack image"
        : device.rackName ? "Rack " + device.rackName : "Outside this rack");
    }
    endpoint.append(node("p", "re-rack-detail-position", location.join(" · ")), portDetailFields(port));
    if (!local) return endpoint;

    const marker = visibleMarker(portId);
    if (marker) {
      const locate = button("btn btn-outline-secondary btn-sm re-rack-detail-locate", "Show in rack");
      locate.addEventListener("click", () => {
        closeDetails(detailsDialog, () => locateMarker(marker));
      });
      endpoint.append(locate);
    } else {
      appendShowSide(endpoint, portId, cable);
    }
    return endpoint;
  }

  function openCableDetails(cable) {
    if (busy || pending || !cable || !cableMatchesDevice(cable) || quickMode !== "normal") return;
    hideWireTooltip();
    selectCable(cable);

    const heading = node("div", "re-rack-detail-heading");
    const title = node("p", "re-rack-detail-name", cableName(cable));
    heading.append(title);
    if (cable.status) heading.append(node("span", "re-rack-detail-status", cable.status));

    const route = node("div", "re-rack-detail-route");
    route.setAttribute("role", "group");
    route.setAttribute("aria-label", "Cable route from end A to end B");
    const connector = node("div", "re-rack-detail-connector");
    connector.setAttribute("aria-hidden", "true");
    route.append(cableRouteEndpoint(cable, "A", cable.a), connector, cableRouteEndpoint(cable, "B", cable.b));

    function updateRouteColor() {
      const color = cableHex(cable).toUpperCase();
      route.style.setProperty("--re-detail-cable-color", color);
      route.toggleAttribute("data-uncolored", !color);
      return color;
    }
    const color = updateRouteColor();
    const colorValue = node("span", "re-rack-detail-color");
    if (color) {
      const swatch = node("span", "re-rack-detail-swatch");
      swatch.style.backgroundColor = color;
      swatch.setAttribute("aria-hidden", "true");
      colorValue.append(swatch, cableColorLabel(color));
    } else {
      colorValue.textContent = "Not specified";
    }

    const properties = node("dl", "re-rack-detail-properties");
    const info = [["Type", cable.type || "Not specified"], ["Profile", cable.profile]];
    if (!cable.metadataEditable) info.push(
      ["Color", colorValue], ["Length", cable.length || "Not specified"],
      ["Description", cable.description], ["Tags", displayedTags(cable.tags)], ["Comments", cable.comments],
    );
    for (const [key, value] of info) {
      if (!value) continue;
      const property = node("div", ["Description", "Tags", "Comments"].includes(key) ? "re-rack-detail-property-wide" : "");
      const detail = node("dd");
      detail.append(value);
      property.append(node("dt", "", key), detail);
      properties.append(property);
    }

    detailsContent.replaceChildren(heading, route, properties);
    if (cable.metadataEditable) {
      detailsContent.append(mountInlineEditor(detailsDialog, "cable", cable, async patch => {
        const payload = await requestMutation(editor.dataset.cableUrl, {action: "update", cable_id: cable.id, ...patch});
        if (payload.id !== cable.id || !payload.cable) throw new Error("NetBox did not confirm the cable update.");
        Object.assign(cable, payload.cable);
        if (payload.history) readHistory(payload.history);
        title.textContent = cableName(cable);
        updateRouteColor();
        if (["label", "color", "length", "description"].some(key => Object.hasOwn(patch, key))) {
          drawCableList();
          updateCableDetail();
        }
        if (Object.hasOwn(patch, "color")) {
          drawDirectory();
          drawnMode = null;
          scheduleDraw();
        }
        updateQuickControls();
      }));
    }
    const trace = renderCableTrace(cable);
    if (trace) detailsContent.append(trace);
    detailsContent.append(netboxDetailLink(cable.url, "Open cable in NetBox"));
    setError(detailsError);
    showDeleteConfirm(false);
    detailsDialog.showModal();
  }

  function portConnectionDetails(port) {
    const section = node("section", "re-rack-port-connection");
    section.append(node("h3", "re-rack-port-connection-title", "Connection"));
    const cable = cables.get(port.cableId);
    const opposite = cable?.a === port.id ? "B" : cable?.b === port.id ? "A" : null;
    if (!opposite) {
      const state = port.occupancy === "cabled" ? "Cable destination unavailable" : occupancyLabels[port.occupancy];
      section.append(node("p", "re-rack-detail-position", state ?? "Unavailable"));
      const manualConnectUrl = httpUrl(port.manualConnectUrl);
      if (manualConnectUrl && !stagedByPort.has(port.id)) {
        const connect = button("btn btn-outline-primary btn-sm me-auto", "Manual Connect");
        connect.addEventListener("click", () => {
          const url = new URL(manualConnectUrl);
          url.searchParams.set("return_url", location.pathname + location.search);
          closeDetails(portDialog, () => location.assign(url.href));
        });
        section.append(connect);
      }
      return section;
    }

    const peer = cableEndpoint(cable, opposite);
    const peerLine = node("p", "re-rack-port-connection-peer");
    if (peer) appendEndpointLinks(peerLine, peer);
    else peerLine.textContent = "Cable destination unavailable";
    const cableLine = node("p", "re-rack-detail-position");
    cableLine.append(netboxDetailLink(cable.url, cableName(cable)));
    section.append(peerLine, cableLine);

    const trace = cable["trace" + opposite];
    const target = trace?.hops.length > 2 ? traceTarget(trace) : null;
    if (target) {
      const label = {complete: "Trace destination", open: "Open end"}[trace.status] ?? "Last visible stop";
      const destination = node("p", "re-rack-port-connection-destination");
      const targetName = node("strong");
      appendEndpointLinks(targetName, traceHopPort(target));
      destination.append(node("span", "re-rack-detail-position", label), targetName);
      section.append(destination);
    }
    if (trace) section.append(traceSection(trace, opposite));
    return section;
  }

  function openPortDetails(port) {
    if (busy || pending || editor.querySelector("dialog[open]")) return;
    finishPortClick();
    hideWireTooltip();
    const heading = node("div", "re-rack-port-detail-heading");
    const title = node("div");
    const portName = node("p", "re-rack-detail-name");
    const deviceName = node("p", "re-rack-detail-device");
    portName.append(netboxDetailLink(port.url, port.name));
    deviceName.append(netboxDetailLink(port.device.url, port.device.name));
    title.append(portName, deviceName);
    const context = port.device.deviceType ? [port.device.deviceType] : [];
    const side = rackSideOfPort(port.id);
    if (side) context.push(side === "front" ? "Rack Front" : "Rack Rear");
    if (mountedTop(data, port.device) !== null) context.push("U " + port.device.position);
    if (context.length) title.append(node("p", "re-rack-detail-position", context.join(" · ")));
    const labelLine = node("p", "re-rack-detail-position");
    function updateLabel() {
      const label = [...new Set([port.label, port.layoutLabel].filter(value => value && value !== port.name))];
      labelLine.hidden = !label.length;
      labelLine.textContent = label.length ? "Label · " + label.join(" · ") : "";
    }
    updateLabel();
    title.append(labelLine);
    heading.append(title, node("span", "re-rack-detail-status", occupancyLabels[port.occupancy] ?? "Unavailable"));
    portDialogContent.replaceChildren(heading, portDetailFields(port, true));
    if (port.metadataEditable) {
      portDialogContent.append(mountInlineEditor(portDialog, port.kind, port, async patch => {
        const payload = await requestMutation(editor.dataset.portUrl, {port_id: port.id, ...patch});
        if (payload.id !== port.id || typeof payload.label !== "string") throw new Error("NetBox did not confirm the port update.");
        Object.assign(port, payload);
        if (Object.hasOwn(patch, "label")) {
          updateLabel();
          markers.get(port.id)?.querySelector(".re-rack-port-label")?.replaceWith(markerLabel(port));
          drawDirectory();
          refreshQuickView();
          invalidateRoutes();
        }
      }));
    } else if (port.tags?.length) {
      const tags = node("div", "re-rack-inline-tag-list");
      tags.append(node("span", "text-secondary small", "Tags"), displayedTags(port.tags));
      portDialogContent.append(tags);
    }
    portDialogContent.append(portConnectionDetails(port));
    portDialog.showModal();
  }

  function openCreateDialog(action) {
    hideWireTooltip();
    createAction = action;
    createForm.reset();
    try {
      const defaults = JSON.parse(localStorage.getItem(cableDefaultsKey));
      if (data.cableTypes.some(({value}) => value === defaults?.type)) {
        createForm.elements.type.value = defaults.type;
      }
      if (typeof defaults?.color === "string" && /^[0-9a-f]{6}$/i.test(defaults.color)) {
        createForm.elements.color.value = "#" + defaults.color;
      }
    } catch {
      // If storage is unavailable or unreadable, use the form's empty defaults.
    }
    setError(createError);
    get("create-summary").textContent = describe(action.source) + " → " + describe(action.target);
    createDialog.showModal();
  }

  function cableLengthValues(form) {
    const length = form.elements.namedItem("length").value || null;
    return {length, length_unit: length === null ? null : form.elements.length_unit.value};
  }

  function cableEditValues() {
    const values = Object.fromEntries(new FormData(editForm));
    values.color = values.color.replace(/^#/, "").toUpperCase();
    return {...values, ...cableLengthValues(editForm)};
  }

  function openCableEdit(cable, field = "label") {
    editingCable = cable;
    editForm.reset();
    editForm.elements.label.value = cable.label ?? "";
    editForm.elements.color.value = cableHex(cable).toUpperCase();
    restoreSelect(editForm.elements.type, cable.typeValue);
    restoreSelect(editForm.elements.status, cable.statusValue);
    editForm.elements.namedItem("length").value = cable.lengthValue ?? "";
    restoreSelect(editForm.elements.length_unit, cable.lengthUnit);
    editForm.elements.description.value = cable.description ?? "";
    editInitialValues = cableEditValues();
    get("edit-endpoints").textContent = ["A", "B"].map(end => listEndpointName(cableEndpoint(cable, end))).join(" → ");
    setError(editError);
    editDialog.showModal();
    editForm.elements[field].focus();
    editForm.elements[field].select();
  }

  function closeContextMenu(restoreFocus = false) {
    if (contextMenu.hidden) return;
    contextMenu.hidden = true;
    contextMenu.replaceChildren();
    contextTrigger?.removeAttribute("aria-expanded");
    if (restoreFocus && contextTrigger?.isConnected) contextTrigger.focus({preventScroll: true});
    contextTrigger = null;
    hideWireTooltip();
  }

  function openContextMenu(event, keyboard = false) {
    if (busy || pending || gesture?.moved) return;
    const target = event.target;
    const entry = target.closest("[data-port-directory-id]");
    const port = portAt(target) ?? ports.get(portIdsByDataset.get(entry?.dataset.portDirectoryId));
    const row = target.closest("[data-cable-list-id]");
    const candidate = port ? cables.get(port.cableId) : row ? cables.get(Number(row.dataset.cableListId)) : cableAt(event);
    const cable = candidate && cableMatchesDevice(candidate) ? candidate : null;
    if (!port && !cable) return;
    finishPortClick();

    const menu = document.createDocumentFragment();
    const normal = quickMode === "normal";
    const trigger = target.closest("[data-port], [data-cable-list-id]") ?? entry?.querySelector("[data-port]");
    const add = (label, run, danger = false) => {
      const item = button("re-rack-context-action" + (danger ? " re-rack-context-danger" : ""), label);
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.addEventListener("click", () => {
        closeContextMenu(true);
        run();
      });
      menu.append(item);
    };
    const divider = () => {
      const item = node("div", "re-rack-context-divider");
      item.setAttribute("role", "separator");
      menu.append(item);
    };

    const heading = port ? describe(port) : cableName(cable);
    const detail = port
      ? [nativePortKind(port), portAdminState(port), occupancyLabels[port.occupancy]].filter(Boolean).join(" · ")
      : ["A", "B"].map(end => listEndpointName(cableEndpoint(cable, end))).join(" → ");
    const title = node("div", "re-rack-context-heading");
    const color = cable && cableHex(cable);
    if (color) {
      const swatch = node("span", "re-rack-context-color");
      swatch.style.backgroundColor = color;
      swatch.setAttribute("aria-hidden", "true");
      title.append(swatch);
    }
    title.append(heading);
    menu.append(title, node("div", "re-rack-context-detail", detail));
    if (port) {
      add("Port details", () => openPortDetails(port));
      if (normal && canStart(port)) {
        add(port.cableId === null ? "Connect from here" : "Move cable end", () => chooseSource(port));
      }
      const marker = visibleMarker(port.id);
      const directoryPort = directory.querySelector('[data-port="' + port.id + '"]');
      if (marker && trigger !== marker) {
        add("Show in rack", () => locateMarker(marker));
      } else if (!directorySection.hidden && directoryPort && !directoryPort.closest("[hidden]")) {
        add("Find in interface directory", () => {
          directorySection.open = true;
          directoryPort.scrollIntoView({block: "nearest", inline: "nearest"});
          directoryPort.focus({preventScroll: true});
        });
      }
      const other = cable && visibleMarker(cable.a === port.id ? cable.b : cable.b === port.id ? cable.a : null);
      if (other) add("Show other end", () => locateMarker(other));
      const url = httpUrl(port.url);
      const kind = nativePortKind(port).toLowerCase() || "interface";
      if (url) add("Open " + kind + " in NetBox", () => location.assign(url));
    }
    if (cable) {
      if (menu.querySelector("[role=menuitem]")) divider();
      if (normal) {
        add("Cable details", () => openCableDetails(cable));
        if (data.canChange && cable.editable) {
          add("Edit cable…", () => openCableEdit(cable));
          add("Change color…", () => openCableEdit(cable, "color"));
        }
        if (!port) {
          for (const [end, id] of [["A", cable.a], ["B", cable.b]]) {
            const endpoint = ports.get(id);
            if (endpoint && canStart(endpoint)) add("Move end " + end, () => chooseSource(endpoint));
          }
        }
      }
      const url = httpUrl(cable.url);
      if (url) add("Open cable in NetBox", () => location.assign(url));
      if (normal && data.canDelete && cable.deletable) {
        divider();
        add("Delete connection…", () => {
          openCableDetails(cable);
          showDeleteConfirm(true);
        }, true);
      }
    }
    const first = menu.querySelector("[role=menuitem]");
    if (!first) return;

    event.preventDefault();
    closeContextMenu();
    hideWireTooltip();
    if (cable) highlightCable(cable, port);
    contextTrigger = trigger ?? scroll;
    if (contextTrigger !== scroll) contextTrigger.setAttribute("aria-expanded", "true");
    const kind = port ? nativePortKind(port) || "Interface" : "Cable";
    contextMenu.setAttribute("aria-label", kind + " actions for " + heading);
    contextMenu.replaceChildren(menu);
    contextMenu.hidden = false;
    const anchor = target.getBoundingClientRect();
    const x = keyboard || (!event.clientX && !event.clientY) ? anchor.left : event.clientX;
    const y = keyboard || (!event.clientX && !event.clientY) ? anchor.bottom : event.clientY;
    const {width, height} = contextMenu.getBoundingClientRect();
    const {clientWidth, clientHeight} = document.documentElement;
    const margin = 8;
    contextMenu.style.left = Math.max(margin, Math.min(x, clientWidth - width - margin)) + "px";
    contextMenu.style.top = Math.max(margin, Math.min(y, clientHeight - height - margin)) + "px";
    first.focus({preventScroll: true});
  }

  function locateMarker(marker) {
    const origin = board.getBoundingClientRect();
    const target = point(marker, origin);
    scroll.scrollTo(target.x - scroll.clientWidth / 2, target.y - scroll.clientHeight / 2);
    marker.focus({preventScroll: true});
  }

  function point(element, origin) {
    const rect = element.getBoundingClientRect();
    return {x: rect.left + rect.width / 2 - origin.left, y: rect.top + rect.height / 2 - origin.top};
  }

  function pathData(points) {
    return points.map(({x, y}, index) => (index ? "L " : "M ") + x + " " + y).join(" ");
  }

  const cableShapes = new WeakMap();

  function cableShape(points, from, to, job = geometry, {compact = false, targetRect} = {}) {
    if (!targetRect && cableShapes.has(points)) return cableShapes.get(points);
    const {anchorPorts, roundPath} = globalThis.NetBoxRackCablePath;
    const fromCard = job?.endpoints.get(from)?.device;
    const toCard = job?.endpoints.get(to)?.device;
    const otherCards = job?.obstacles.filter(card => card.id !== fromCard && card.id !== toCard) ?? [];
    const protectedAreas = job?.protectedAreas ?? [];
    const anchored = anchorPorts(points, job?.portRects.get(from), targetRect ?? job?.portRects.get(to),
      [...otherCards, ...protectedAreas], {preserveAligned: compact, bounds: job?.bounds});
    let shape = {d: pathData(anchored), points: anchored};
    if (job?.strategy === "pcb" && anchored.length >= 3) {
      const clearance = Math.max(0, (job.deviceClearance ?? 0) - 1);
      const cornerObstacles = otherCards.map(card => growRect(card, clearance));
      shape = roundPath(anchored, [...cornerObstacles, ...protectedAreas], compact ? 3 : undefined, true);
    }
    if (!targetRect) cableShapes.set(points, shape);
    return shape;
  }

  function displayedCableShape(cable, points, job = geometry, overrides = combinedRoutes) {
    const compact = overrides.get(cable.id);
    const route = compact ?? points;
    return route ? cableShape(route, cable.a, cable.b, job, {compact: Boolean(compact)}) : null;
  }

  function wire(d, className, color) {
    const element = document.createElementNS(SVG, "path");
    element.setAttribute("d", d);
    element.setAttribute("class", className);
    if (color) element.setAttribute("stroke", color);
    return element;
  }

  function gripPoint(points, distance) {
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1];
      const to = points[index];
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      if (length >= distance) {
        const ratio = distance / length;
        return {x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio};
      }
      distance -= length;
    }
    return points.at(-1);
  }

  function cableHandle(cable, portId, x, y, color) {
    function circle(radius, className) {
      const element = document.createElementNS(SVG, "circle");
      element.setAttribute("cx", x);
      element.setAttribute("cy", y);
      element.setAttribute("r", radius);
      element.setAttribute("class", className);
      return element;
    }

    const hit = circle(9, "re-rack-wire-handle");
    hit.dataset.wire = cable.id;
    hit.dataset.cableEnd = portId;
    const visible = circle(3.5, "re-rack-wire-handle-visible");
    visible.setAttribute("fill", color);
    return [hit, visible];
  }

  function distanceToPath(point, path) {
    let closest = Infinity;
    for (let index = 1; index < path.length; index++) {
      const from = path[index - 1];
      const to = path[index];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const squaredLength = dx * dx + dy * dy;
      const projection = squaredLength
        ? Math.min(1, Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / squaredLength))
        : 0;
      closest = Math.min(closest, (point.x - from.x - dx * projection) ** 2 +
        (point.y - from.y - dy * projection) ** 2);
    }
    return closest;
  }

  function cableAt(event) {
    const hit = event.target?.closest?.("[data-wire]");
    const cable = hit ? cables.get(Number(hit.dataset.wire)) : null;
    if (!cable || !cableMatchesDevice(cable)) return null;
    if (hit.hasAttribute("data-cable-end")) return cable;

    // Wider hit strokes make narrow cables easier to click. In an overlap, use the nearest visible line.
    const origin = wires.getBoundingClientRect();
    const pointer = {x: event.clientX - origin.left, y: event.clientY - origin.top};
    let closest = cable;
    let distance = distanceToPath(pointer, shownRoutes.get(cable.id));
    for (const [id, path] of shownRoutes) {
      if (id === cable.id) continue;
      const candidate = distanceToPath(pointer, path);
      if (candidate + 0.01 < distance) {
        distance = candidate;
        closest = cables.get(id);
      }
    }
    return closest;
  }

  let hoveredPort = null;
  let hoverEnd = null;
  let hoverPoints = [];
  let hoverFrom = null;
  let hoverIsStub = false;
  let tooltipPlacement = null;
  let cableHoverPointer = null;
  let hoverTargetKey = null;
  let hoverTimer = null;
  const hoverDelayMs = 100;

  function pointerEnds(cable, x, y, nearPort = null) {
    const ends = ["A", "B"].map(end => ({end, port: cableEndpoint(cable, end)}));
    if (nearPort) return ends[0].port?.id === nearPort.id ? ends.reverse() : ends;
    return ends.map(endpoint => {
      const {port} = endpoint;
      const marker = visibleMarker(port?.id);
      if (!marker) return {...endpoint, distance: Infinity};
      const {x: endX, y: endY} = point(marker, {left: 0, top: 0});
      return {...endpoint, distance: Math.hypot(x - endX, y - endY)};
    }).sort((a, b) => a.distance === b.distance ? 0 : b.distance - a.distance);
  }

  function stubPoints(portId, marker, protectedAreas = geometry?.protectedAreas ?? []) {
    const wireRect = wires.getBoundingClientRect();
    const start = point(marker, wireRect);
    const across = start.x <= wireRect.width / 2 ? 1 : -1;
    const down = ports.get(portId)?.y < 0.5 ? 1 : -1;
    const diagonal = Math.SQRT1_2;
    const directions = [
      [across, 0], [0, down], [0, -down], [-across, 0],
      [across * diagonal, down * diagonal], [-across * diagonal, down * diagonal],
      [across * diagonal, -down * diagonal], [-across * diagonal, -down * diagonal],
    ];
    let longest = 0;
    let end = start;
    for (const [dx, dy] of directions) {
      const toEdge = (at, step, limit) => step > 0 ? (limit - at) / step : step < 0 ? -at / step : Infinity;
      let length = Math.min(32, toEdge(start.x, dx, wireRect.width), toEdge(start.y, dy, wireRect.height));
      for (const area of protectedAreas) {
        if (area.port === portId && area.kind === "port") continue;
        let entry = 0;
        let exit = length;
        for (const [at, step, low, high] of [
          [start.x, dx, area.left - 2, area.right + 2],
          [start.y, dy, area.top - 2, area.bottom + 2],
        ]) {
          if (!step) {
            if (at < low || at > high) exit = -1;
            continue;
          }
          const first = (low - at) / step;
          const last = (high - at) / step;
          entry = Math.max(entry, Math.min(first, last));
          exit = Math.min(exit, Math.max(first, last));
        }
        if (entry < exit) length = entry;
      }
      if (length <= longest) continue;
      longest = length;
      end = {x: start.x + dx * length, y: start.y + dy * length};
      if (length === 32) break;
    }
    const {width, height} = marker.getBoundingClientRect();
    if (longest >= Math.max(width, height) / 2 + 5) return [start, end];

    // Dense rows can leave no visible straight exit. Turn into the gap between rows.
    const turn = {x: start.x, y: Math.max(0, Math.min(wireRect.height, start.y + down * (height / 2 + 1.5)))};
    end = {x: Math.max(0, Math.min(wireRect.width, turn.x + across * 24)), y: turn.y};
    return [start, turn, end];
  }

  function visibleCablePath(cable, preferredPortId) {
    const a = visibleMarker(cable.a);
    const b = visibleMarker(cable.b);
    if (a && b) {
      const shape = displayedCableShape(cable, routes?.get(cable.id));
      return shape ? {...shape, from: cable.a, stub: false} : null;
    }
    const from = [preferredPortId, cable.a, cable.b].find(id => visibleMarker(id));
    if (from === undefined) return null;
    return {...cableShape(stubPoints(from, visibleMarker(from)), from), from, stub: true};
  }

  function drawTracePreview(cable, end = null) {
    for (const marker of traceMarkers) marker.classList.remove("re-rack-trace-end-highlight");
    traceMarkers.clear();
    for (const marker of traceTargets) {
      marker.classList.remove("re-rack-trace-target-highlight");
      delete marker.dataset.traceTargetStatus;
    }
    traceTargets.clear();
    for (const card of traceDevices) card.classList.remove("re-rack-trace-device-highlight");
    traceDevices.clear();
    tracePoints = [];
    traceLayer.replaceChildren();
    if (!cable) return;
    const traces = cableTraces(cable).filter(([direction]) => !end || direction === end);

    const seen = new Set([cable.id]);
    function mark(portId) {
      if (portId === cable.a || portId === cable.b || dimPortForCableFocus(ports.get(portId))) return;
      const marker = visibleMarker(portId);
      if (!marker) return;
      marker.classList.add("re-rack-trace-end-highlight");
      traceMarkers.add(marker);
    }

    function markTarget(portId, status = "direct") {
      const marker = visibleMarker(portId);
      if (!marker) return false;
      marker.classList.add("re-rack-trace-target-highlight");
      marker.dataset.traceTargetStatus = status;
      traceTargets.add(marker);
      return true;
    }

    function continuation({x, y}) {
      const hint = document.createElementNS(SVG, "circle");
      hint.setAttribute("class", "re-rack-trace-continuation re-rack-trace-handoff");
      hint.setAttribute("cx", x);
      hint.setAttribute("cy", y);
      hint.setAttribute("r", "4");
      traceLayer.append(hint);
    }

    if (end && !traces.length) {
      markTarget(cable[end.toLowerCase()]);
      return;
    }
    for (const [direction, trace] of traces) {
      const target = traceTarget(trace);
      const targetVisible = markTarget(target ? target.portId : cable[direction.toLowerCase()], trace.status);
      for (const {portId, deviceId, kind} of trace.hops) {
        mark(portId);
        if (kind === "interface" || !Number.isInteger(deviceId)) continue;
        for (const card of board.querySelectorAll('[data-rack-device="' + deviceId + '"]')) {
          card.classList.add("re-rack-trace-device-highlight");
          traceDevices.add(card);
        }
      }
      let drawn = false;
      for (const segment of trace.segments) {
        if (seen.has(segment.id)) continue;
        seen.add(segment.id);
        mark(segment.a);
        mark(segment.b);
        const visible = visibleCablePath(segment);
        if (!visible) continue;
        drawn = true;
        tracePoints.push(visible.points);
        const stroke = wire(visible.d, "re-rack-wire-trace");
        stroke.dataset.traceWire = segment.id;
        traceLayer.append(wire(visible.d, "re-rack-wire-trace-casing"), stroke);
        if (visible.stub) continuation(visible.points.at(-1));
      }
      if (drawn || (targetVisible && ["complete", "open"].includes(trace.status))) continue;
      const direct = visibleCablePath(cable);
      if (direct?.stub) {
        continuation(direct.points.at(-1));
      } else {
        const last = trace.hops.slice(1).findLast(hop => visibleMarker(hop.portId));
        if (last) {
          const marker = visibleMarker(last.portId);
          const {x, y} = point(marker, wires.getBoundingClientRect());
          const offset = marker.getBoundingClientRect().width / 2 + 6;
          continuation({x: x + offset, y});
        }
      }
    }
  }

  function highlightCable(cable, port = null, end = null) {
    if (cable && !cableMatchesDevice(cable)) return;
    if (cable === hoveredCable && port === hoveredPort) {
      if (end !== hoverEnd) {
        hoverEnd = end;
        drawTracePreview(cable ?? selectedCable, end);
      }
      return;
    }
    if (hoveredCable) {
      for (const id of [hoveredCable.a, hoveredCable.b, hoveredPort?.id]) {
        markers.get(id)?.classList.remove("re-rack-end-highlight");
      }
      for (const grip of handleLayer.querySelectorAll('[data-wire="' + hoveredCable.id + '"]')) {
        grip.nextElementSibling.classList.remove("re-rack-wire-handle-hovered");
      }
    }
    hoveredCable = cable;
    highlightVirtualSleeves(cable ?? selectedCable);
    hoveredPort = port;
    hoverEnd = end;
    hoverPoints = [];
    hoverFrom = null;
    hoverIsStub = false;
    resetTooltipPlacement();
    hoverLayer.replaceChildren();
    wires.classList.toggle("re-rack-wires-hovering", Boolean(cable));
    drawTracePreview(cable ?? selectedCable, end);
    if (!cable) return;
    for (const id of [cable.a, cable.b, port?.id]) {
      visibleMarker(id)?.classList.add("re-rack-end-highlight");
    }
    for (const grip of handleLayer.querySelectorAll('[data-wire="' + cable.id + '"]')) {
      grip.nextElementSibling.classList.add("re-rack-wire-handle-hovered");
    }
    const visible = visibleCablePath(cable, port?.id);
    if (!visible) return;
    hoverPoints = visible.points;
    hoverFrom = visible.from;
    hoverIsStub = visible.stub;
    const path = visible.d;
    if (!visible.stub) hoverLayer.append(wire(path, "re-rack-wire-casing"));
    const className = "re-rack-wire re-rack-wire-hovered" + (visible.stub ? " re-rack-wire-hover-stub" : "");
    const color = cableColor(cable);
    const stroke = wire(path, className, color);
    stroke.dataset.wireHighlight = cable.id;
    hoverLayer.append(...cableStrokes(stroke, color, cable.id));
  }

  function resetTooltipPlacement() {
    tooltipPlacement = null;
    tooltip.removeAttribute("data-compact");
    tooltip.removeAttribute("data-narrow");
    if (tooltip.hasAttribute("data-docked")) {
      tooltip.removeAttribute("data-docked");
      tooltipGuide.after(tooltip);
      tooltipDock.hidden = true;
    }
    tooltipGuide.setAttribute("hidden", "");
  }

  function drawTooltipGuide(anchor, edge) {
    tooltipGuide.toggleAttribute("hidden", !anchor || !edge);
    if (!anchor || !edge) return;
    guideLine.setAttribute("d", pathData([anchor, edge]));
    guideRing.setAttribute("cx", anchor.x);
    guideRing.setAttribute("cy", anchor.y);
  }

  function positionWireTooltip(event) {
    const viewport = {right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight};
    const frame = scroll.getBoundingClientRect();
    const origin = wires.getBoundingClientRect();
    const clip = {
      left: Math.max(0, frame.left + scroll.clientLeft),
      top: Math.max(0, frame.top + scroll.clientTop),
      right: Math.min(viewport.right, frame.left + scroll.clientLeft + scroll.clientWidth),
      bottom: Math.min(viewport.bottom, frame.top + scroll.clientTop + scroll.clientHeight),
    };
    const screenSegments = points => tooltipGeometry.visibleSegments(
      points.map(({x, y}) => ({x: x + origin.left, y: y + origin.top})), clip,
    );
    const segments = screenSegments(hoverPoints);
    const obstacles = segments.concat(tracePoints.flatMap(screenSegments));
    const pointer = {x: event.clientX, y: event.clientY};
    let probe = pointer;
    if (hoverIsStub) {
      const {x, y} = hoverPoints.at(-1);
      probe = {x: x + origin.left, y: y + origin.top};
    } else if (hoveredPort && hoverPoints.length) {
      const from = hoveredPort.id !== hoverFrom && visibleMarker(hoveredPort.id)
        ? hoverPoints.slice().reverse() : hoverPoints;
      const {x, y} = gripPoint(from, 12);
      probe = {x: x + origin.left, y: y + origin.top};
    }
    const anchor = tooltipGeometry.nearestPoint(segments, probe);

    if (!tooltip.hasAttribute("data-docked")) {
      const margin = 8;
      const bounds = {left: margin, top: margin, right: viewport.right - margin, bottom: viewport.bottom - margin};
      function findPlace() {
        const {width, height} = tooltip.getBoundingClientRect();
        return tooltipGeometry.place({
          anchor: anchor ?? pointer, width, height, bounds, segments: obstacles, previous: tooltipPlacement,
        });
      }
      let placement = findPlace();
      if (!placement && !tooltip.hasAttribute("data-compact")) {
        tooltip.setAttribute("data-compact", "");
        placement = findPlace();
      }
      if (!placement && viewport.right <= 480 && tooltip.hasAttribute("data-tooltip-cable") && !tooltip.hasAttribute("data-narrow")) {
        tooltip.setAttribute("data-narrow", "");
        placement = findPlace();
      }
      if (placement) {
        tooltipPlacement = placement;
        tooltip.style.left = placement.left + "px";
        tooltip.style.top = placement.top + "px";
        drawTooltipGuide(anchor, placement.edge);
        return;
      }

      // If no rectangle can fit beside this wire, the inspector keeps the drawing clear.
      tooltip.setAttribute("data-docked", "");
      tooltipDock.append(tooltip);
      tooltipDock.hidden = false;
    }

    const rect = tooltip.getBoundingClientRect();
    const edge = anchor && {
      x: Math.max(rect.left, Math.min(rect.right, anchor.x)),
      y: Math.max(rect.top, Math.min(rect.bottom, anchor.y)),
    };
    const edgeVisible = edge && edge.x >= 0 && edge.x <= viewport.right && edge.y >= 0 && edge.y <= viewport.bottom;
    drawTooltipGuide(anchor, edgeVisible ? edge : null);
  }

  function hideWireTooltip() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    hoverTargetKey = null;
    if (!tooltip.hidden) resetTooltipPlacement();
    tooltip.hidden = true;
    tooltipKey = null;
    cableHoverPointer = null;
    showSleeveHover(null);
    highlightCable(null);
  }

  function listHoverEnd(cable) {
    const aVisible = Boolean(visibleMarker(cable.a));
    const bVisible = Boolean(visibleMarker(cable.b));
    if (aVisible !== bVisible) return aVisible ? "B" : "A";
    return cable.traceA && !cable.traceB ? "A" : "B";
  }

  function offviewEndpointLabel(port) {
    if (!port || visibleMarker(port.id)) return "";
    const device = ports.get(port.id)?.device ?? data.devices.find(candidate => candidate.id === port.deviceId);
    if (!device) return port.device.rackName ? "Rack " + port.device.rackName : "Outside this rack";

    const mounted = mountedTop(data, device) !== null;
    let reason = "Port not placed on rack image";
    if (!deviceInFocus(device.id)) reason = "Device hidden by filter";
    else if (!mounted) reason = "Device not mounted";
    else if (!portFaceVisible(port.id)) reason = "Rack side not shown";
    else if (!portRowVisible(port.id)) reason = "Port row hidden";
    return mounted ? reason + " · U " + device.position : reason;
  }

  function tooltipPortLocation(port) {
    const offview = offviewEndpointLabel(port);
    if (offview) return offview;
    const side = rackSideOfPort(port.id);
    if (!side) return "";
    const face = side === "front" ? "Rack front" : "Rack rear";
    return port.device.position != null ? face + " · U " + port.device.position : face;
  }

  function traceHopPort(hop) {
    return ports.get(hop.portId) ?? endpointPort(hop);
  }

  function tooltipVlanName(vlan) {
    return vlan.name ? vlan.vid + " · " + vlan.name : String(vlan.vid);
  }

  function vlanChip(vlan, useFill = false) {
    const chip = node("span", "re-rack-tooltip-vlan", tooltipVlanName(vlan));
    const fill = useFill && vlanColors.fill(vlan, vlanColorSettings);
    if (fill) chip.style.setProperty("--re-rack-tooltip-vlan-color", fill);
    return chip;
  }

  function portPoeText(port) {
    if (nativePortKind(port)) return "Not applicable";
    return [port.poeMode, port.poeType].filter(Boolean).join(" · ") || "Not set";
  }

  function tooltipTaggedVlans(port) {
    if (port.vlanMode === "tagged-all") return "All VLANs";
    const vlans = port.taggedVlans ?? [];
    if (!vlans.length) return "None";
    const list = node("span", "re-rack-tooltip-vlan-list");
    if (vlans.length <= 8) {
      for (const vlan of vlans) list.append(vlanChip(vlan));
      return list;
    }
    const ids = [...new Set(vlans.map(vlan => vlan.vid))].sort((a, b) => a - b);
    const ranges = [];
    for (const id of ids) {
      const last = ranges.at(-1);
      if (last?.[1] + 1 === id) last[1] = id;
      else ranges.push([id, id]);
    }
    const shown = ranges.slice(0, 12);
    for (const [start, end] of shown) {
      list.append(node("span", "re-rack-tooltip-vlan", start === end ? String(start) : start + "–" + end));
    }
    const remaining = ranges.slice(shown.length).reduce((total, [start, end]) => total + end - start + 1, 0);
    if (remaining) list.append(node("span", "", "+" + remaining + " more"));
    return list;
  }

  function tooltipPortPreview(card, port) {
    const marker = visibleMarker(port.id);
    const size = marker?.getBoundingClientRect();
    const markerText = marker?.querySelector(".re-rack-port-label");
    const font = markerText ? parseFloat(getComputedStyle(markerText).fontSize) *
      Number(markerText.style.getPropertyValue("--re-rack-port-label-scale")) : 0;
    const text = portDisplayLabel(port);
    const minimumWidth = text.length > 4 ? 88 : 56;
    card.style.setProperty("--re-rack-preview-width", Math.ceil(Math.max(minimumWidth, (size?.width ?? 0) * 4)) + "px");
    const state = port.occupancy ? portState(port) : "connected";
    const preview = node("span", "re-rack-tooltip-port-preview re-rack-port-" + state);
    preview.dataset.tooltipPortPreview = port.id ?? "";
    preview.style.minHeight = Math.ceil(Math.max(46, (size?.height ?? 0) * 4)) + "px";
    preview.style.fontSize = Math.max(24, font * 4) + "px";
    updatePortVlanFill(preview, port);
    const label = node("span", "re-rack-tooltip-preview-label", text);
    label.dataset.tooltipPreviewLabel = "";
    preview.append(label);
    return preview;
  }

  function tooltipEndpoint({port, end}, role, trace = null) {
    const card = node("div", "re-rack-tooltip-endpoint");
    if (end) card.dataset.tooltipEndpoint = end;
    if (role === "source") card.dataset.tooltipSource = "";
    if (role === "target") {
      card.dataset.tooltipTarget = "";
      card.dataset.targetStatus = trace?.status ?? "direct";
    }
    const heading = node("div", "re-rack-tooltip-endpoint-heading");
    heading.append(node("span", "re-rack-tooltip-end-badge", end ? "End " + end : nativePortKind(port) || "Interface"));
    if (role) {
      const label = {source: "From", next: "Next port", target: trace?.status === "open" ? "Open end" : "Destination"}[role];
      heading.append(node("span", "re-rack-tooltip-endpoint-role", label));
    } else if (!end) {
      heading.append(node("span", "re-rack-tooltip-endpoint-role", occupancyLabels[port.occupancy] ?? "Unavailable"));
    }
    card.append(heading, node("div", "re-rack-tooltip-device", port?.device.name ?? "Unknown endpoint"));
    if (!port) return card;
    if (port.device.deviceType) card.append(node("div", "re-rack-tooltip-device-type", port.device.deviceType));
    card.append(tooltipPortPreview(card, port), node("span", "re-rack-tooltip-endpoint-name", port.name));
    const location = tooltipPortLocation(port);
    if (location) card.append(node("div", "re-rack-tooltip-offview", location));
    if (trace) card.append(node("div", "re-rack-tooltip-target-status", traceStatus(trace)));
    return card;
  }

  function renderPortTooltip(port, withCable) {
    const panel = node("div", "re-rack-tooltip-port-details");
    panel.dataset.tooltipPortDetails = "";
    if (withCable) {
      const heading = node("div", "re-rack-tooltip-port-heading");
      heading.append(node("span", "re-rack-tooltip-port-title", describe(port)),
        node("span", "re-rack-tooltip-port-state", occupancyLabels[port.occupancy] ?? "Unavailable"));
      panel.append(heading);
    }
    const fields = node("dl", "re-rack-tooltip-port-fields");
    for (const [label, value] of [
      ["Type", port.type || nativePortKind(port) || "Not set"],
      ["PoE", portPoeText(port)],
      ["Untagged", port.untaggedVlan ? vlanChip(port.untaggedVlan, true) : "None"],
      ["Tagged", tooltipTaggedVlans(port)],
    ]) {
      const row = node("div");
      const detail = node("dd");
      detail.append(value);
      row.append(node("dt", "", label), detail);
      fields.append(row);
    }
    panel.append(fields);
    return panel;
  }

  function renderWireTooltip(cable, near, far) {
    const trace = cable["trace" + far.end];
    const hop = traceTarget(trace);
    tooltip.setAttribute("data-tooltip-cable", "");
    tooltip.replaceChildren();
    const endpoints = node("div", "re-rack-tooltip-endpoints");
    const arrow = node("span", "re-rack-tooltip-direction", "→");
    arrow.setAttribute("aria-hidden", "true");
    endpoints.append(tooltipEndpoint(near, "source"), arrow,
      hop ? tooltipEndpoint(far, "next") : tooltipEndpoint(far, "target", trace));
    tooltip.append(endpoints);
    const via = trace && traceSection(trace, far.end, true);
    if (via) tooltip.append(via);
    if (hop) {
      const peer = traceHopPort(hop);
      const target = node("div", "re-rack-tooltip-target");
      target.dataset.tooltipTarget = "";
      target.dataset.targetStatus = trace.status;
      if (trace.active === false) target.dataset.inactive = "";
      const label = {complete: "Destination", open: "Open end"}[trace.status] ?? "Last visible stop";
      const kicker = node("div", "re-rack-tooltip-kicker", label);
      kicker.append(node("span", "re-rack-tooltip-target-status", traceStatus(trace)));
      target.append(kicker, node("div", "re-rack-tooltip-device", peer.device.name ?? "Unknown endpoint"));
      target.append(node("span", "re-rack-tooltip-port", peer.name));
      if (peer.device.deviceType) target.append(node("span", "re-rack-tooltip-device-type", peer.device.deviceType));
      const location = tooltipPortLocation(peer);
      if (location) target.append(node("div", "re-rack-tooltip-offview", location));
      tooltip.append(target);
    }
    const meta = node("div", "re-rack-tooltip-meta");
    const swatch = node("span", "re-rack-tooltip-swatch");
    swatch.setAttribute("aria-hidden", "true");
    meta.append(swatch);
    for (const field of [cable.label, cable.type, cable.length].filter(Boolean)) meta.append(node("span", "", field));
    tooltip.append(meta);
    const accent = cableColor(cable);
    tooltip.style.setProperty("--re-rack-tooltip-accent", accent);
    tooltipGuide.style.setProperty("--re-rack-tooltip-accent", accent);
  }

  function wireHoverTarget(event) {
    if (!contextMenu.hidden || gesture || busy || event.pointerType === "touch") return null;
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest("[data-cable-list-id]");
    const listedCable = row && cableList.contains(row) ? cables.get(Number(row.dataset.cableListId)) : null;
    const entry = target?.closest("[data-port-directory-id]");
    const directoryPort = entry && directory.contains(entry) ? ports.get(portIdsByDataset.get(entry.dataset.portDirectoryId)) : null;
    const port = listedCable ? null : portAt(target) ?? directoryPort;
    if (!port && !listedCable) {
      const sleeve = sleeveAt(event, target);
      if (sleeve) return {sleeve, key: "sleeve:" + sleeve.dataset.wireSleeve};
    }
    const candidate = listedCable ?? (port ? cables.get(port.cableId) : cableAt(event));
    const group = expandedBundle && bundleGroups.find(item => item.key === expandedBundle);
    const cable = candidate && cableMatchesDevice(candidate) && (!group || group.ids.includes(candidate.id)) ? candidate : null;
    if (!port && !cable) return null;
    const key = port ? "port:" + port.id : (listedCable ? "list:" : "wire:") + cable.id;
    return {port, cable, listedCable, key};
  }

  function hoverEventAt(pointer) {
    return {...pointer, target: document.elementFromPoint(pointer.clientX, pointer.clientY)};
  }

  function queueWireTooltip(event, hover = wireHoverTarget(event)) {
    if (portDialog.open) return;
    if (!hover) {
      hideWireTooltip();
      return;
    }
    const pointer = {clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType};
    if (hover.key !== hoverTargetKey) {
      hideWireTooltip();
      hoverTargetKey = hover.key;
      if (!hover.sleeve) {
        hoverTimer = setTimeout(() => {
          hoverTimer = null;
          queueWireTooltip(hoverEventAt(cableHoverPointer));
        }, hoverDelayMs);
      }
    }
    cableHoverPointer = pointer;
    if (hoverTimer === null) showWireTooltip(event, hover);
  }

  function showWireTooltip(event, {port, cable, listedCable, sleeve}) {
    if (sleeve) {
      showSleeveHover(sleeve);
      return;
    }
    if (!cable) {
      highlightCable(null);
      const key = "port:" + port.id;
      if (key !== tooltipKey) {
        resetTooltipPlacement();
        tooltip.removeAttribute("data-tooltip-cable");
        tooltip.replaceChildren(tooltipEndpoint({port}), renderPortTooltip(port, false));
        tooltip.style.removeProperty("--re-rack-tooltip-accent");
        tooltipKey = key;
      }
      tooltip.hidden = false;
      positionWireTooltip(event);
      return;
    }
    if (listedCable && !cable.traceA && !cable.traceB && visibleMarker(cable.a) && visibleMarker(cable.b)) {
      highlightCable(cable);
      tooltip.hidden = true;
      tooltipKey = null;
      return;
    }
    const listEnd = listedCable && listHoverEnd(cable);
    const [far, near] = listEnd
      ? [listEnd, listEnd === "A" ? "B" : "A"].map(end => ({end, port: cableEndpoint(cable, end)}))
      : pointerEnds(cable, event.clientX, event.clientY, port);
    highlightCable(cable, port, far.end);
    const key = cable.id + ":" + far.end + ":" + (port?.id ?? "");
    if (key !== tooltipKey) {
      resetTooltipPlacement();
      renderWireTooltip(cable, near, far);
      if (port) {
        tooltip.querySelector(".re-rack-tooltip-meta").before(renderPortTooltip(port, true));
      }
      tooltipKey = key;
    }
    tooltip.hidden = false;
    positionWireTooltip(event);
  }

  function wirePortAt(event) {
    const handle = event.target.closest("[data-cable-end]");
    if (handle) return ports.get(portIdsByDataset.get(handle.dataset.cableEnd));
    const cable = cableAt(event);
    if (!canMove(cable)) return null;
    const [, near] = pointerEnds(cable, event.clientX, event.clientY);
    return near.distance <= 28 ? near.port : null;
  }

  function fitPortLabels() {
    const labels = [];
    // Cache the unwrapped dimensions of each label and fit to the area inside the status frame.
    for (const [id, marker] of markers) {
      if (!visibleMarker(id)) continue;
      const label = marker.querySelector(".re-rack-port-label");
      const frame = label.parentElement;
      const width = Math.max(0, frame.clientWidth - 1);
      const height = Math.max(0, frame.clientHeight - 1);
      if (!portLabelSizes.has(label)) {
        portLabelSizes.set(label, {width: label.offsetWidth + 1, height: label.offsetHeight + 1});
      }
      const natural = portLabelSizes.get(label);
      const singleScale = Math.min(1, width / natural.width, height / natural.height);
      let wrapWidth = "";
      // Try a balanced block only when two lines could be larger than the single line.
      if (width && height / (2 * natural.height) > singleScale * 1.05) {
        const lines = Math.max(2, Math.round(Math.sqrt(natural.width * height / (natural.height * width))));
        wrapWidth = Math.floor(lines * natural.height * width / height) + "px";
      }
      labels.push({label, width, height, singleScale, wrapWidth});
    }

    // Batch the trial widths before measuring so that dense racks need only one extra layout pass.
    for (const {label, wrapWidth} of labels) {
      if (label.style.maxWidth !== wrapWidth) label.style.maxWidth = wrapWidth;
    }
    const fits = labels.map(({label, width, height, singleScale, wrapWidth}) => {
      const wrappedScale = wrapWidth ? Math.min(1,
        width / (Math.max(label.offsetWidth, label.scrollWidth) + 1), height / (label.offsetHeight + 1)) : 0;
      const wrap = wrappedScale > singleScale * 1.05;
      return {label, wrap, scale: String(wrap ? wrappedScale : singleScale)};
    });
    for (const {label, wrap, scale} of fits) {
      if (!wrap && label.style.maxWidth) label.style.removeProperty("max-width");
      if (label.style.getPropertyValue("--re-rack-port-label-scale") !== scale) {
        label.style.setProperty("--re-rack-port-label-scale", scale);
      }
    }
  }

  function fitPhotos() {
    const trim = viewTrim.checked;
    const fit = board.hasAttribute("data-fit") && !board.hasAttribute("data-print-plan");
    const scrollLeft = scroll.scrollLeft;
    const scrollTop = scroll.scrollTop;
    // Measure the ordinary rack layout, even when a previous crop is active.
    board.removeAttribute("data-trimmed");
    if (fit) fitRackWidth();
    const layouts = new Map();
    for (const [card, {photo, image}] of photos) {
      const rect = card.getBoundingClientRect();
      const hasImage = Boolean(image?.naturalWidth && image?.naturalHeight);
      const scale = hasImage ? Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight) : 1;
      const width = hasImage ? image.naturalWidth * scale : rect.width;
      const height = hasImage ? image.naturalHeight * scale : rect.height;
      layouts.set(card, {photo, rect, width, height, fixed: hasImage || trim});
    }
    for (const {photo, width, height, fixed} of layouts.values()) {
      photo.style.width = fixed ? width + "px" : "";
      photo.style.height = fixed ? height + "px" : "";
      photo.style.setProperty("--re-rack-artwork-scale", width / 1000);
    }
    if (trim && layouts.size) {
      trimPhotos(layouts, fit);
      if (fit) scroll.scrollTop = scrollTop;
      else scroll.scrollLeft = scrollLeft;
    }
    fitPortLabels();
  }

  function trimPhotos(layouts, fit) {
    // Use the same cuts in each face's local coordinates, with room for the stroke and end grips.
    let left = Infinity;
    let right = Infinity;
    const clearance = 12;
    for (const [id, marker] of markers) {
      if (!visibleMarker(id)) continue;
      const {rect: card} = layouts.get(marker.closest("[data-route-obstacle]"));
      const rect = marker.getBoundingClientRect();
      left = Math.min(left, rect.left - card.left - clearance);
      right = Math.min(right, card.right - rect.right - clearance);
    }
    if (!Number.isFinite(left)) return;
    left = Math.max(0, Math.floor(left));
    right = Math.max(0, Math.floor(right));
    const cut = left + right;
    if (!cut) return;

    // Keep sparse cards identifiable and limit how much a narrow cluster can enlarge the rack in Fit.
    const shortestCard = Math.min(...Array.from(layouts.values(), ({rect}) => rect.width));
    const minimumWidth = fit ? shortestCard / 2 : 96;
    const maxCut = Math.max(0, shortestCard - minimumWidth);
    const ratio = Math.min(1, maxCut / cut);
    left = Math.floor(left * ratio);
    right = Math.floor(right * ratio);
    if (!left && !right) return;

    const trimmedWidth = shortestCard - left - right;
    const scale = fit ? shortestCard / trimmedWidth : 1;
    if (fit) applyZoomScale(zoomScale * scale);
    for (const {photo, rect, width, height} of layouts.values()) {
      if (fit) {
        photo.style.width = (width * scale) + "px";
        photo.style.height = (height * scale) + "px";
        photo.style.setProperty("--re-rack-artwork-scale", width * scale / 1000);
      }
      photo.style.setProperty("--re-rack-trim-photo-left", (((rect.width - width) / 2 - left) * scale) + "px");
    }
    if (!fit) {
      const fullWidth = board.getBoundingClientRect().width;
      const faceCount = rackFace === "both" ? 2 : 1;
      workspace.style.setProperty("--re-rack-trim-width", (fullWidth - faceCount * (left + right)) + "px");
    }
    board.setAttribute("data-trimmed", "");
  }

  function relativeRect(element, origin) {
    const {left, top, right, bottom} = element.getBoundingClientRect();
    const stable = (value) => Math.round(value * 100) / 100;
    return {
      left: stable(left - origin.left), top: stable(top - origin.top),
      right: stable(right - origin.left), bottom: stable(bottom - origin.top),
    };
  }

  function growRect(rect, padding) {
    return {left: rect.left - padding, top: rect.top - padding,
      right: rect.right + padding, bottom: rect.bottom + padding};
  }

  function cutoutPath({left, top, right, bottom}) {
    return "M " + left + " " + top + " H " + right + " V " + bottom + " H " + left + " Z";
  }

  function updatePortMask(bounds, cuts, target = mask) {
    target.setAttribute("x", 0);
    target.setAttribute("y", 0);
    target.setAttribute("width", bounds.width);
    target.setAttribute("height", bounds.height);
    const surface = document.createElementNS(SVG, "rect");
    surface.setAttribute("width", bounds.width);
    surface.setAttribute("height", bounds.height);
    surface.setAttribute("fill", "#fff");
    const holes = wire(Array.from(cuts, cutoutPath).join(" "), "re-rack-port-cutouts");
    holes.setAttribute("fill", "#000");
    target.replaceChildren(surface, holes);
  }

  function computeRoutes(job) {
    return globalThis.NetBoxRackRouting.routeCables(
      job.connections, job.obstacles, job.bounds, job.protectedAreas,
      {strategy: job.strategy, spacing: job.spacing, horizontalSpacing: job.horizontalSpacing,
        deviceClearance: job.deviceClearance},
    );
  }

  function publishRoutes(job, result) {
    if (job !== geometry) return;
    geometryRoutes = result;
    // A resize may have invalidated the layout while the worker was running.
    if (routes !== null) routes = geometryRoutes;
    scheduleDraw();
  }

  function startWorkerJob(job) {
    activeJob = job;
    routingWorker.postMessage({
      connections: job.connections, obstacles: job.obstacles,
      bounds: job.bounds, protectedAreas: job.protectedAreas,
      strategy: job.strategy, spacing: job.spacing, horizontalSpacing: job.horizontalSpacing,
      deviceClearance: job.deviceClearance,
      scripts: Array.from(document.querySelectorAll("[data-rack-routing-script]"), script => script.src),
    });
  }

  function disableWorker() {
    routingWorker?.terminate();
    routingWorker = null;
    workerUnavailable = true;
    const newest = queuedJob ?? activeJob;
    activeJob = null;
    queuedJob = null;
    if (newest === geometry) publishRoutes(newest, computeRoutes(newest));
  }

  function routeInWorker(job) {
    if (workerUnavailable || !editor.dataset.routingWorkerUrl) return false;
    try {
      if (!routingWorker) {
        routingWorker = new Worker(editor.dataset.routingWorkerUrl);
        routingWorker.addEventListener("message", (event) => {
          const completed = activeJob;
          if (!event.data.paths) {
            disableWorker();
            return;
          }
          activeJob = null;
          publishRoutes(completed, new Map(event.data.paths));
          const next = queuedJob;
          queuedJob = null;
          if (next === geometry) startWorkerJob(next);
        });
        routingWorker.addEventListener("error", disableWorker);
      }
      if (activeJob) queuedJob = job;
      else startWorkerJob(job);
      return true;
    } catch {
      routingWorker?.terminate();
      routingWorker = null;
      workerUnavailable = true;
      activeJob = null;
      queuedJob = null;
      return false;
    }
  }

  function measureRouting(acceptCable, strategy) {
    fitPhotos();
    const origin = wires.getBoundingClientRect();
    const obstacles = Array.from(board.querySelectorAll("[data-route-obstacle]"), card => ({
      id: card.dataset.routeObstacle, ...relativeRect(card, origin),
    }));
    const endpoints = new Map();
    const protectedAreas = [];
    const portRects = new Map();
    for (const [port, marker] of markers) {
      if (marker.hidden) continue;
      const rect = {port, ...relativeRect(marker, origin)};
      endpoints.set(port, {
        x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2,
        device: marker.closest("[data-route-obstacle]").dataset.routeObstacle, port,
      });
      portRects.set(port, rect);
      protectedAreas.push({port, kind: "port", ...growRect(rect, .75)});
    }
    const connections = [];
    for (const cable of cables.values()) {
      if (!acceptCable(cable)) continue;
      const a = endpoints.get(cable.a);
      const b = endpoints.get(cable.b);
      if (a && b) connections.push({id: cable.id, a, b});
    }
    const bounds = {width: origin.width, height: origin.height};
    const outline = (strategy === "pcb" ? 2.75 : 4) * cableDrawingScale();
    const spacing = Math.ceil(outline + parallelCableGap);
    const horizontalSpacing = spacing + extraHorizontalGap;
    const deviceClearance = deviceEdgeClearance + (board.hasAttribute("data-print-plan") ? 5 : outline + 1) / 2;
    return {connections, obstacles, bounds, protectedAreas, endpoints, strategy, portRects,
      spacing, horizontalSpacing, deviceClearance};
  }

  function routeVisibleCables() {
    const strategy = board.dataset.routingStrategy;
    let visibleCount = 0;
    for (const cable of cables.values()) {
      if (cableMatchesDevice(cable) && visibleMarker(cable.a) && visibleMarker(cable.b)) visibleCount++;
    }
    // In a dense elevation, leave room for more lanes on both sides and around the top and bottom.
    const extraBay = Math.min(144, Math.max(0, (visibleCount - (strategy === "pcb" ? 24 : 14)) * 4));
    if (routingBay !== extraBay) {
      routingBay = extraBay;
      board.style.setProperty("--re-rack-extra-bay", routingBay + "px");
      applyElevationSpacing();
    }
    const job = measureRouting(cableMatchesDevice, strategy);
    const {connections, obstacles, bounds, protectedAreas, portRects, spacing, horizontalSpacing, deviceClearance} = job;
    const key = JSON.stringify([connections, obstacles, bounds, protectedAreas, strategy, spacing, horizontalSpacing, deviceClearance]);
    if (key !== geometryKey) {
      geometryKey = key;
      geometry = job;
      previewRoute = null;
      updatePortMask(bounds, portRects.values());
      // At most one worker job and the most recent replacement are in flight.
      const workerThreshold = strategy === "pcb" ? 24 : 40;
      geometryRoutes = connections.length >= workerThreshold && routeInWorker(geometry)
        ? new Map()
        : computeRoutes(geometry);
    }
    return geometryRoutes;
  }

  function clearGrip(points, length) {
    const scale = cableDrawingScale();
    for (let distance = 12 * scale; distance <= Math.min(30 * scale, length / 2 - 1); distance += 4) {
      const point = gripPoint(points, distance);
      if (!geometry.protectedAreas.some(area => point.x > area.left - 2 && point.x < area.right + 2 &&
          point.y > area.top - 2 && point.y < area.bottom + 2)) return point;
    }
    return null;
  }

  function bundleName(group) {
    return [group.a, group.b].map(endpoint => {
      const [id, face] = endpoint.device.split(":");
      const device = data.devices.find(device => String(device.id) === id);
      return (device?.name ?? id) + (rackFace === "both" ? " (" + face + ")" : "");
    }).join(" ↔ ");
  }

  function chooseBundle(key, focusPanel = false) {
    if (busy || pending || gesture || expandedBundle === key) return;
    const focusKey = key ?? expandedBundle;
    expandedBundle = key;
    drawnMode = null;
    selectCable(null);
    if (focusPanel) {
      requestAnimationFrame(() => {
        [...bundlePairList.children].find(button => button.dataset.bundleKey === focusKey)?.focus({preventScroll: true});
      });
    }
  }

  function drawBundlePanel(active, group) {
    bundlePanel.hidden = !active;
    if (!active) return;
    const key = JSON.stringify([rackFace, expandedBundle, bundleGroups.map(item => [item.key, item.ids])]);
    if (key !== bundlePanelKey) {
      bundlePanelKey = key;
      const focusKey = bundlePanel.contains(document.activeElement) && document.activeElement.dataset.bundleKey;
      bundlePairList.replaceChildren(...bundleGroups.map(item => {
        const choice = button("btn btn-outline-secondary btn-sm", bundleName(item) + " · " + item.ids.length);
        choice.dataset.bundleKey = item.key;
        choice.setAttribute("aria-pressed", String(item === group));
        choice.addEventListener("click", () => chooseBundle(item.key, true));
        return choice;
      }));
      const title = get("bundle-title");
      title.hidden = bundleClear.hidden = bundleCableList.hidden = !group;
      title.textContent = group ? bundleName(group) : "";
      get("bundle-status").textContent = bundleGroups.length
        ? bundleGroups.length + (bundleGroups.length === 1 ? " device pair" : " device pairs")
        : "No connections between visible ports.";
      bundleCableList.replaceChildren(...(group?.ids ?? []).map(id => {
        const cable = cables.get(id);
        const choice = button("btn btn-outline-secondary btn-sm",
          listEndpointName(cableEndpoint(cable, "A")) + " ↔ " + listEndpointName(cableEndpoint(cable, "B")));
        choice.dataset.bundleCableId = id;
        choice.addEventListener("click", () => selectCable(cable));
        return choice;
      }));
      if (focusKey) {
        [...bundlePairList.children].find(button => button.dataset.bundleKey === focusKey)?.focus({preventScroll: true});
      }
    }
    for (const choice of bundleCableList.children) {
      choice.setAttribute("aria-pressed", String(Number(choice.dataset.bundleCableId) === selectedCable?.id));
    }
  }

  function drawBundles(mode) {
    const active = mode === "bundles";
    bundleGroups = active ? globalThis.NetBoxRackBundles.group(
      geometry.connections.filter(({id}) => cableButtons.get(id)?.hidden === false),
    ) : [];
    const group = bundleGroups.find(item => item.key === expandedBundle);
    expandedBundle = group?.key ?? null;
    if (active && !group) {
      globalThis.NetBoxRackBundles.draw(bundleLayer, bundleGroups, geometry.obstacles, geometry.bounds, {
        onSelect: item => chooseBundle(item.key, true),
        describe: bundleName, protectedAreas: geometry.protectedAreas, scale: cableDrawingScale(),
        deviceClearance: geometry.deviceClearance,
      });
    } else {
      bundleLayer.replaceChildren();
    }
    drawBundlePanel(active, group);
    return group;
  }

  function planVirtualTubes(job, paths, stubs = new Map()) {
    if (!viewVirtualCombine.checked || paths.size < 3) return {paths: new Map(), tubes: []};
    const connections = job.connections.filter(({id}) => paths.has(id));
    const foreignRoutes = new Map(Array.from(stubs, ([id, shape]) => [id, shape.points]));
    for (const [id, points] of paths) {
      const cable = cables.get(id);
      const hasA = job.endpoints.has(cable.a);
      const hasB = job.endpoints.has(cable.b);
      const shape = cableShape(points, hasA ? cable.a : cable.b, hasA && hasB ? cable.b : undefined, job);
      foreignRoutes.set(id, shape.points);
    }
    const compactPoints = (id, points) => {
      const {a, b} = cables.get(id);
      return cableShape(points, a, b, job, {compact: true}).points;
    };
    // Reserve even the widest painted casing so hovering a cable cannot crowd the tube.
    const foreignStrokeWidth = board.hasAttribute("data-print-plan") ? 5 : 8 * cableDrawingScale();
    return globalThis.NetBoxRackVirtualCombine.planTubes(connections, portRows, paths, {
      ...job, deviceEdgeClearance, foreignRoutes, compactPoints, foreignStrokeWidth,
    });
  }

  function drawVirtualSleeves(layer, tubes) {
    const byCable = new Map();
    const areas = [];
    const fragment = document.createDocumentFragment();
    for (const tube of tubes) {
      const {ids, width, axis = "vertical"} = tube;
      const horizontal = axis === "horizontal";
      const left = horizontal ? tube.left : tube.x - width / 2;
      const right = horizontal ? tube.right : tube.x + width / 2;
      const top = horizontal ? tube.y - width / 2 : tube.top;
      const bottom = horizontal ? tube.y + width / 2 : tube.bottom;
      const sleeve = document.createElementNS(SVG, "g");
      sleeve.setAttribute("class", "re-rack-wire-sleeve");
      sleeve.setAttribute("aria-hidden", "true");
      sleeve.dataset.wireSleeve = ids.join(" ");
      sleeve.dataset.wireSleeveAxis = axis;
      const shell = document.createElementNS(SVG, "rect");
      shell.setAttribute("class", "re-rack-wire-sleeve-shell");
      shell.setAttribute("x", left);
      shell.setAttribute("width", right - left);
      shell.setAttribute("y", top);
      shell.setAttribute("height", bottom - top);
      shell.setAttribute("rx", 3);
      const collars = horizontal
        ? `M ${left + 4} ${top} V ${bottom} M ${right - 4} ${top} V ${bottom}`
        : `M ${left} ${top + 4} H ${right} M ${left} ${bottom - 4} H ${right}`;
      sleeve.append(shell, wire(collars, "re-rack-wire-sleeve-collars"));
      fragment.append(sleeve);
      areas.push({sleeve, left, right, top, bottom});
      for (const id of ids) {
        if (!byCable.has(id)) byCable.set(id, []);
        byCable.get(id).push(sleeve);
      }
    }
    layer.replaceChildren(fragment);
    return {byCable, areas};
  }

  function sleeveAt(event, target) {
    if (!sleeveAreas.length || !target || !board.contains(target)) return null;
    const origin = wires.getBoundingClientRect();
    const x = event.clientX - origin.left;
    const y = event.clientY - origin.top;
    return sleeveAreas.find(area => x >= area.left && x <= area.right && y >= area.top && y <= area.bottom)?.sleeve;
  }

  function showSleeveHover(sleeve) {
    if (sleeveHover?.parentElement === sleeve) return;
    sleeveHover?.remove();
    sleeveHover = null;
    if (!sleeve) return;

    const overlay = document.createElementNS(SVG, "g");
    overlay.dataset.wireSleeveOverlay = "";
    const clip = document.createElementNS(SVG, "clipPath");
    clip.id = "re-rack-sleeve-hover-clip";
    clip.append(sleeve.firstElementChild.cloneNode());
    const members = document.createElementNS(SVG, "g");
    members.setAttribute("clip-path", "url(#" + clip.id + ")");
    const ids = sleeve.dataset.wireSleeve.split(" ").map(Number);
    const laneWidth = Math.min(1, 8 / ids.length);
    const cores = document.createDocumentFragment();
    for (const id of ids) {
      const cable = cables.get(id);
      if (!cable) continue;
      const shape = displayedCableShape(cable, routes?.get(id));
      if (!shape) continue;
      const rim = wire(shape.d, "re-rack-wire-sleeve-member", "#fff");
      rim.setAttribute("stroke-width", laneWidth);
      members.append(rim);
      const stroke = wire(shape.d, "re-rack-wire-sleeve-member", cableColor(cable));
      stroke.setAttribute("stroke-width", laneWidth * .72);
      stroke.dataset.wireSleeveMember = id;
      cores.append(stroke);
    }
    members.append(cores);
    overlay.append(clip, members);
    sleeve.append(overlay);
    sleeveHover = overlay;
  }

  function highlightVirtualSleeves(cable) {
    const next = cableSleeves.get(cable?.id) ?? [];
    if (next === activeSleeves) return;
    for (const sleeve of activeSleeves) sleeve.classList.remove("re-rack-wire-sleeve-active");
    for (const sleeve of next) sleeve.classList.add("re-rack-wire-sleeve-active");
    activeSleeves = next;
  }

  function drawCablePaths(mode) {
    const pointer = cableHoverPointer;
    const previousHoverKey = hoverTargetKey;
    const waitingForHover = hoverTimer !== null;
    if (!waitingForHover) hideWireTooltip();
    shownRoutes.clear();
    const group = drawBundles(mode);
    const individualIds = new Set(group?.ids);
    const visibleRoutes = new Map([...routes].filter(([id]) => mode === "bundles"
      ? individualIds.has(id) : mode === "all" || id === selectedCable?.id));
    const stubCandidates = mode === "bundles"
      ? group ? [] : Array.from(cableButtons, ([id, row]) => row.hidden ? null : cables.get(id)).filter(Boolean)
      : cableFocusDevice ? cables.values() : selectedCable ? [selectedCable] : [];
    const stubs = new Map();
    for (const cable of stubCandidates) {
      if (!cableMatchesDevice(cable) || routes.has(cable.id)) continue;
      const shape = visibleCablePath(cable);
      if (shape?.stub) stubs.set(cable.id, shape);
    }
    const combined = planVirtualTubes(geometry, visibleRoutes, stubs);
    combinedRoutes = combined.paths;
    const fragment = document.createDocumentFragment();
    const handles = document.createDocumentFragment();
    let selection = [];
    for (const [id, route] of visibleRoutes) {
      const cable = cables.get(id);
      const active = cable === selectedCable;
      const {d: path, points} = displayedCableShape(cable, route);
      shownRoutes.set(id, points);
      const color = cableColor(cable);
      const stroke = wire(path, "re-rack-wire" + (active ? " re-rack-wire-selected" : ""), color);
      stroke.dataset.wireVisual = id;
      stroke.classList.toggle("re-rack-wire-staged-unplug", stagedDeletes.has(id));
      const hit = wire(path, "re-rack-wire-hit");
      hit.dataset.wire = id;
      const strokes = cableStrokes(stroke, color, cable.id);
      if (active) selection = [wire(path, "re-rack-wire-casing"), ...strokes, hit];
      else fragment.append(...strokes, hit);

      const length = points.slice(1).reduce((total, point, index) =>
        total + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
      if (canMove(cable) && length >= 28) {
        const a = clearGrip(points, length);
        const b = clearGrip(points.slice().reverse(), length);
        if (a) handles.append(...cableHandle(cable, cable.a, a.x, a.y, color));
        if (b) handles.append(...cableHandle(cable, cable.b, b.x, b.y, color));
      }
    }
    for (const [id, visible] of stubs) {
      const cable = cables.get(id);
      const active = cable === selectedCable;
      const color = cableColor(cable);
      const path = visible.d;
      const style = active ? " re-rack-wire-selected re-rack-wire-selected-stub" : " re-rack-wire-focus-stub";
      const stroke = wire(path, "re-rack-wire" + style, color);
      stroke.dataset.wireVisual = id;
      const strokes = cableStrokes(stroke, color, id);
      if (cableFocusDevice || mode === "bundles") {
        const hit = wire(path, "re-rack-wire-hit");
        hit.dataset.wire = id;
        shownRoutes.set(id, visible.points);
        strokes.push(hit);
      }
      if (active) selection.push(...strokes);
      else fragment.append(...strokes);
    }
    fragment.append(...selection);
    wireLayer.replaceChildren(fragment);
    handleLayer.replaceChildren(handles);
    const sleeves = drawVirtualSleeves(sleeveLayer, combined.tubes);
    cableSleeves = sleeves.byCable;
    sleeveAreas = sleeves.areas;
    highlightVirtualSleeves(hoveredCable ?? selectedCable);
    if (pointer && !waitingForHover) {
      const event = hoverEventAt(pointer);
      const hover = wireHoverTarget(event);
      if (hover?.key === previousHoverKey) hoverTargetKey = previousHoverKey;
      queueWireTooltip(event, hover);
    } else drawTracePreview(selectedCable);
    if (exportDialog.open && !exporting) updateExportOptions();
  }

  function drawWires() {
    frame = 0;
    routes ??= routeVisibleCables();
    const mode = lines.value === "bundles" ? "bundles" : cableFocusDevice ? "all" : lines.value;
    if (routes !== drawnRoutes || mode !== drawnMode || selectedCable !== drawnSelection) {
      drawCablePaths(mode);
      drawnRoutes = routes;
      drawnMode = mode;
      drawnSelection = selectedCable;
    }

    previewLayer.replaceChildren();
    if (quickMode === "connect" && mode !== "none") {
      for (const {source, target} of stagedConnections.values()) {
        if (!cableMatchesDevice({a: source, b: target})) continue;
        const a = geometry.endpoints.get(source);
        const b = geometry.endpoints.get(target);
        if (a && b) {
          const shape = cableShape([a, b], source, target);
          previewLayer.append(wire(shape.d, "re-rack-wire-rim"),
            wire(shape.d, "re-rack-wire re-rack-wire-staged-connect", "#25966c"));
        }
      }
    }
    if (!gesture?.moved) return;
    const movingCable = cables.get(gesture.port.cableId);
    const previewOrigin = movingCable
      ? (movingCable.a === gesture.port.id ? movingCable.b : movingCable.a)
      : gesture.port.id;
    const a = geometry.endpoints.get(previewOrigin) ?? geometry.endpoints.get(gesture.port.id);
    if (!a) return;
    const origin = wires.getBoundingClientRect();
    const target = geometry.endpoints.get(dropTarget?.id);
    const b = target ?? {x: gesture.x - origin.left, y: gesture.y - origin.top};
    if (b.x < 0 || b.x > origin.width || b.y < 0 || b.y > origin.height) return;
    let points = [a, b];
    if (target) {
      if (previewRoute?.from !== a.port || previewRoute?.to !== b.port) {
        const connection = {id: "preview", a, b};
        const {obstacles, bounds, protectedAreas, strategy, spacing, horizontalSpacing, deviceClearance} = geometry;
        const paths = globalThis.NetBoxRackRouting.routeCables(
          [connection], obstacles, bounds, protectedAreas, {strategy, spacing, horizontalSpacing, deviceClearance},
        );
        previewRoute = {from: a.port, to: b.port, points: paths.get(connection.id)};
      }
      points = previewRoute.points;
    }
    const marker = target && visibleMarker(target.port);
    const targetRect = marker ? {port: target.port, ...relativeRect(marker, origin)} : undefined;
    const shape = cableShape(points, a.port, b.port, geometry, {targetRect});
    previewLayer.append(wire(shape.d, "re-rack-wire-rim"),
      wire(shape.d, "re-rack-wire re-rack-wire-preview", "#36baff"));
  }

  function invalidateRoutes() {
    routes = null;
    scheduleDraw();
  }

  function scheduleDraw() {
    if (!frame) frame = requestAnimationFrame(drawWires);
  }

  function updateMarks() {
    for (const element of editor.querySelectorAll("[data-port]")) {
      const id = portIdsByDataset.get(element.dataset.port);
      element.setAttribute("aria-pressed", String(
        source?.id === id || selectedCable?.a === id || selectedCable?.b === id ||
        (quickMode !== "normal" && (quickSource?.id === id || stagedByPort.has(id) ||
          stagedDeletes.has(ports.get(id)?.cableId)))
      ));
      element.classList.toggle("re-rack-drop", dropTarget?.id === id);
    }
    cancel.hidden = busy || !source || Boolean(pending);
    scheduleDraw();
  }

  function selectCable(cable) {
    if (busy || pending) return;
    source = null;
    selectedCable = cable && cableMatchesDevice(cable) ? cable : null;
    if (lines.value === "bundles" && selectedCable) {
      const group = bundleGroups.find(item => item.ids.includes(selectedCable.id));
      if (group && group.key !== expandedBundle) {
        expandedBundle = group.key;
        drawnMode = null;
      }
    }
    updateCableDetail();
    updateMarks();
    announce(selectedCable ? cableName(selectedCable) + " selected." : idleMessage());
  }

  function canStart(port) {
    if (busy || pending || port.blocked || !portRowVisible(port.id) || !portFaceVisible(port.id) ||
        stagedByPort.has(port.id) || stagedDeletes.has(port.cableId)) return false;
    return port.cableId === null ? data.canAdd : canMove(cables.get(port.cableId));
  }

  function chooseSource(port) {
    if (!canStart(port)) return;
    source = port;
    const cable = cables.get(port.cableId);
    selectedCable = quickMode === "normal" && cable && cableMatchesDevice(cable) ? cable : null;
    updateCableDetail();
    updateMarks();
    const action = port.cableId === null ? "connect" : "move this cable end";
    announce(describe(port) + " selected. Choose a free port to " + action + ".");
  }

  function validTarget(port) {
    return source && port?.id !== source.id && quickAvailable(port);
  }

  function useTarget(port) {
    if (!validTarget(port)) {
      announce("Choose another free port. Existing connections are kept.", true);
      return;
    }
    const action = {source, target: port};
    if (source.cableId === null) {
      openCreateDialog(action);
      return;
    }
    hideWireTooltip();
    pending = action;
    updateMarks();
    setError(moveError);
    get("move-summary").textContent =
      "Move " + describe(source) + " to " + describe(port) + "? The other end stays connected.";
    moveDialog.showModal();
  }

  function clearOperation() {
    pending = null;
    source = null;
    dropTarget = null;
    updateMarks();
    announce(selectedCable ? cableName(selectedCable) + " selected." : idleMessage());
  }

  function connectionBody(action) {
    return {source: action.source.id, target: action.target.id, cable_id: action.source.cableId};
  }

  async function requestMutation(endpoint, body) {
    const url = httpUrl(endpoint);
    const csrf = editor.querySelector("[name=csrfmiddlewaretoken]")?.value;
    if (!url || !csrf) throw new Error("The editor could not start this request. Refresh the page and try again.");
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {"Content-Type": "application/json", "Accept": "application/json", "X-CSRFToken": csrf},
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "NetBox could not apply this change. Refresh if the rack changed.");
    return payload;
  }

  async function save(body, errorBox) {
    if (busy) return;
    const deleting = body.action === "delete";
    const updating = body.action === "update";
    const batching = body.action === "batch";
    const restoring = body.action === "history";
    const reportError = (message) => {
      if (errorBox) setError(errorBox, message);
      if (batching) announceQuick(message, true);
      announce(message, true);
    };
    const dialog = errorBox?.closest("dialog");
    const controls = dialog?.open
      ? Array.from(dialog.querySelectorAll("button, input, select"), control => [control, control.disabled])
      : [];
    for (const [control] of controls) control.disabled = true;
    if (errorBox) setError(errorBox);
    busy = true;
    updateMarks();
    updateQuickControls();
    let progress = "Saving connection…";
    if (deleting) progress = "Deleting cable…";
    else if (updating) progress = "Saving cable details…";
    else if (batching) progress = "Applying queued cable changes…";
    else if (restoring) progress = "Restoring cable history…";
    announce(progress);
    if (batching) announceQuick(progress);
    try {
      const payload = await requestMutation(editor.dataset.cableUrl, body);
      const valid = batching ? Array.isArray(payload.ids) && Boolean(payload.history)
        : restoring ? Boolean(payload.history) : deleting || Number.isInteger(payload.id);
      if (!valid) {
        throw new Error(payload.error || "NetBox could not apply this change. Refresh if the rack changed.");
      }
      if (body.cable_id === null) {
        try {
          localStorage.setItem(cableDefaultsKey, JSON.stringify({type: body.type, color: body.color}));
        } catch {
          // Saving the connection does not depend on browser storage.
        }
      }
      let message = "Connection saved.";
      if (deleting) message = "Cable deleted.";
      else if (updating) message = "Cable details saved.";
      else if (batching) {
        const count = body.operations.length;
        message = count === 1 ? "Applied one cable change." : "Applied " + count + " cable changes.";
        clearQuickQueue();
      } else if (restoring) {
        message = "Cable history restored.";
      }
      announce(message + " Refreshing the rack…");
      // Keep queued work through the reload after saving a separate drag operation.
      const queue = stagedCount() ? {
        deletes: Array.from(stagedDeletes),
        connections: Array.from(stagedConnections.values()),
        preferredSourceDevice,
      } : null;
      history.replaceState({...history.state, reRackEditor: {
        left: scroll.scrollLeft,
        top: scroll.scrollTop,
        zoom: zoom.value,
        lines: lines.value,
        offImage: offImage.checked,
        search: search.value,
        message,
        queue,
      }}, "");
      if (queue) window.removeEventListener("beforeunload", warnStagedNavigation);
      location.reload();
    } catch (error) {
      busy = false;
      for (const [control, disabled] of controls) control.disabled = disabled;
      updateMarks();
      updateQuickControls();
      reportError(error.message || "The cable change could not be saved.");
      if (moveDialog.open) moveSubmit.focus();
      if (editDialog.open) editSubmit.focus();
    }
  }

  function portAt(element) {
    const match = element?.closest("[data-port]");
    return match && editor.contains(match) ? ports.get(portIdsByDataset.get(match.dataset.port)) : null;
  }

  function finishPortClick(activate = false) {
    if (!pendingPortClick) return;
    const {timer, port, control} = pendingPortClick;
    pendingPortClick = null;
    clearTimeout(timer);
    if (activate && control.isConnected && !control.closest("[hidden]")) activatePort(port);
  }

  function activatePort(port) {
    if (busy || pending || editor.querySelector("dialog[open]")) return;
    if (quickMode !== "normal") {
      if (quickPortVisible(port)) {
        if (quickMode === "unplug") queueUnplug(port);
        else queueConnection(port);
      }
    } else if (source?.id === port.id) clearOperation();
    else if (source) useTarget(port);
    else if (port.cableId !== null) {
      const cable = cables.get(port.cableId);
      if (cable) openCableDetails(cable);
      else announce("This port already has a connection outside this view.");
    } else if (canStart(port)) chooseSource(port);
    else announce("This port is unavailable for editing.");
  }

  function portAtPoint(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit?.closest("[data-wire]")) return portAt(hit);
    // Wide SVG hit areas can overlap a visible port near a cable end.
    for (const element of document.elementsFromPoint(x, y)) {
      const port = portAt(element);
      if (port) return port;
    }
    return null;
  }

  function trackDragTarget() {
    const candidate = portAtPoint(gesture.x, gesture.y);
    const target = validTarget(candidate) ? candidate : null;
    if (dropTarget !== target) {
      dropTarget = target;
      updateMarks();
    }
  }

  function edgeDelta(position, start, end) {
    const edge = Math.min(40, (end - start) / 4);
    if (position - start < edge) return -Math.ceil((start + edge - position) / 4);
    if (end - position < edge) return Math.ceil((position - end + edge) / 4);
    return 0;
  }

  function scrollWhileDragging() {
    scrollFrame = 0;
    if (!gesture?.moved) return;
    if (!dropTarget) {
      const {x, y} = gesture;
      for (const panel of [scroll, inspectorScroll]) {
        const {left, right, top, bottom} = panel.getBoundingClientRect();
        if (x < left || x > right || y < top || y > bottom) continue;
        const {scrollLeft, scrollTop} = panel;
        panel.scrollBy(edgeDelta(x, left, right), edgeDelta(y, top, bottom));
        if (panel.scrollLeft !== scrollLeft || panel.scrollTop !== scrollTop) {
          trackDragTarget();
          scheduleDraw();
        }
        break;
      }
    }
    scrollFrame = requestAnimationFrame(scrollWhileDragging);
  }

  function readViewPreferences(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? {};
    } catch {
      return {};
    }
  }

  function writeViewPreferences(key, preferences) {
    try {
      localStorage.setItem(key, JSON.stringify(preferences));
    } catch {
      // The editor can still be used if browser storage is disabled.
    }
  }

  function restoreSelect(control, value) {
    if (Array.from(control.options).some(option => option.value === value)) control.value = value;
  }

  function saveViewPreferences() {
    writeViewPreferences(viewPreferencesKey, {
      connections: viewConnections.checked, directory: viewDirectory.checked, trim: viewTrim.checked,
      virtualCombine: viewVirtualCombine.checked,
      connectionsOpen: connectionsSection.open, directoryOpen: directorySection.open,
      zoom: zoom.value, lines: lines.value, images: deviceImages.value,
      interfaceHighlight: interfaceHighlight.value, routingStrategy: routingStrategy.value, portFill: portFill.value,
      vlanColors: {
        rules: vlanColorSettings.rules.map(({ids, color}) => ({ids, color})),
        fallback: vlanColorSettings.fallback,
      },
    });
  }

  function saveRackPreferences() {
    writeViewPreferences(rackPreferencesKey, {
      face: rackFace, devices: Array.from(focusedDevices).join(","), hiddenRows: Array.from(hiddenRows).join(","),
      cableDevice: cableFocusDevice ? String(cableFocusDevice.id) : "",
      vlan: vlanQuery.value, vlanKind: vlanKind.value, search: search.value, offImage: offImage.checked,
      deviceGaps: Object.fromEntries(savedGaps),
    });
  }

  function applyViewOptions() {
    hideWireTooltip();
    connectionsSection.hidden = !viewConnections.checked;
    directorySection.hidden = !viewDirectory.checked;
    workspace.toggleAttribute("data-view-no-sidebar", !viewConnections.checked && !viewDirectory.checked);
    invalidateRoutes();
  }

  function setDeviceImages() {
    board.dataset.imageMode = deviceImages.value;
    saveViewPreferences();
  }

  function cableDrawingScale() {
    return zoom.value === "fit" ? Math.max(.85, Math.min(1.5, .78 + zoomScale * .22)) : 1;
  }

  function applyZoomScale(scale) {
    zoomScale = scale;
    board.style.setProperty("--re-rack-zoom", scale);
    board.style.setProperty("--re-rack-unit", (baseRackUnit * scale) + "px");
    board.style.setProperty("--re-rack-fit-cable-scale", cableDrawingScale());
    applyElevationSpacing();
  }

  function fitRackWidth() {
    if (!elevationSpacing || !scroll.clientWidth) return;
    const viewportHeight = window.visualViewport?.height ?? document.documentElement.clientHeight;
    const scrollTop = Math.max(0, scroll.getBoundingClientRect().top);
    const fitHeight = Math.max(160, Math.floor(viewportHeight - scrollTop - 12));
    const maxHeight = fitHeight + "px";
    if (workspace.style.getPropertyValue("--re-rack-fit-height") !== maxHeight) {
      workspace.style.setProperty("--re-rack-fit-height", maxHeight);
    }
    // The grid has already reserved the unit rail, the routing bays and the gap between faces.
    const face = facePanels.find(panel => !panel.hidden);
    const fitted = Math.max(.25, face.getBoundingClientRect().width / (baseRackUnit * rackFaceAspect));
    if (fitted !== zoomScale) applyZoomScale(fitted);
  }

  function setZoom() {
    const fit = zoom.value === "fit";
    workspace.toggleAttribute("data-fit", fit);
    board.toggleAttribute("data-fit", fit);
    if (fit) {
      board.style.setProperty("--re-rack-fit-cable-scale", cableDrawingScale());
    } else {
      workspace.style.removeProperty("--re-rack-fit-height");
      applyZoomScale(Number(zoom.value));
    }
    invalidateRoutes();
    saveViewPreferences();
  }

  function renderDeviceOptions() {
    const fragment = document.createDocumentFragment();
    for (const {id, name} of data.devices) {
      const label = node("label", "form-check re-rack-device-option");
      const input = node("input", "form-check-input");
      input.type = "checkbox";
      input.value = id;
      input.checked = focusedDevices.has(id);
      label.append(input, node("span", "form-check-label", name));
      fragment.append(label);
    }
    if (!data.devices.length) fragment.append(node("span", "text-muted small", "No visible devices."));
    deviceOptions.append(fragment);
    updateDeviceFilter();
  }

  function updateDeviceFilter() {
    const count = focusedDevices.size;
    const total = data.devices.length;
    deviceSummary.textContent = count ? "Devices: " + count + " of " + total : "Devices: All";
    deviceReset.hidden = !count;
    deviceStatus.textContent = count
      ? "Showing " + count + " of " + total + " devices."
      : (total ? "Showing all " + total + " devices." : "No visible devices.");
  }

  function renderPortRows() {
    const devices = new Map(data.devices.map(device => [device.id, device.name]));
    const groups = new Map();
    for (const row of portRows) {
      if (!deviceInFocus(row.deviceId) || !rackFaceVisible(row.rackFace)) continue;
      const key = row.deviceId + ":" + row.rackFace;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const fragment = document.createDocumentFragment();
    for (const rows of groups.values()) {
      const {deviceId, rackFace} = rows[0];
      const title = devices.get(deviceId) + " · " + (rackFace === "front" ? "Front" : "Rear");
      const group = node("div", "re-rack-row-group");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", title);
      group.append(node("div", "re-rack-row-group-label", title));
      for (const row of rows) {
        const option = node("div", "re-rack-row-option");
        const toggle = node("label", "form-check re-rack-row-option-toggle");
        const input = node("input", "form-check-input");
        input.type = "checkbox";
        input.value = row.id;
        input.dataset.portRowChoice = "";
        const name = "Row " + row.number;
        const count = row.ports.length + (row.ports.length === 1 ? " port" : " ports");
        toggle.append(input, node("span", "form-check-label", name + " · " + count));
        option.append(toggle);
        if (rows.length > 1) {
          const only = button("btn btn-outline-secondary btn-sm re-rack-row-only", "Only");
          only.dataset.onlyPortRow = row.id;
          only.setAttribute("aria-label", "Show only " + name + " on " + title);
          option.append(only);
        }
        group.append(option);
      }
      fragment.append(group);
    }
    rowOptions.replaceChildren(fragment);
    updatePortRows();
  }

  function updatePortRows() {
    const choices = rowOptions.querySelectorAll("input[data-port-row-choice]");
    let visible = 0;
    for (const input of choices) {
      input.checked = !hiddenRows.has(input.value);
      if (input.checked) visible++;
    }
    rowFilter.hidden = !choices.length;
    if (rowFilter.hidden) rowFilter.open = false;
    rowReset.hidden = !hiddenRows.size;
    rowSummary.textContent = visible === choices.length ? "Port rows" : "Port rows: " + visible + " of " + choices.length;
    rowStatus.textContent = choices.length
      ? "Showing " + visible + " of " + choices.length + " port rows."
      : "No placed port rows in the current devices.";
  }

  function clearViewInteraction() {
    finishPortClick();
    const oldGesture = gesture;
    gesture = null;
    if (oldGesture) {
      suppressClick = oldGesture.moved;
      if (editor.hasPointerCapture(oldGesture.id)) editor.releasePointerCapture(oldGesture.id);
    }
    selectedCable = null;
    clearOperation();
    hideWireTooltip();
    drawTracePreview(null);
    wireLayer.replaceChildren();
    sleeveLayer.replaceChildren();
    sleeveAreas = [];
    combinedRoutes.clear();
    handleLayer.replaceChildren();
    previewLayer.replaceChildren();
    shownRoutes.clear();
    drawnRoutes = null;
  }

  function persistViewFilters() {
    const url = new URL(location.href);
    if (focusedDevices.size) url.searchParams.set("devices", Array.from(focusedDevices).join(","));
    else url.searchParams.delete("devices");
    if (cableFocusDevice) url.searchParams.set("cableDevice", cableFocusDevice.id);
    else url.searchParams.delete("cableDevice");
    if (hiddenRows.size) url.searchParams.set("hiddenRows", Array.from(hiddenRows).sort().join(","));
    else url.searchParams.delete("hiddenRows");
    if (rackFace === "front") url.searchParams.delete("face");
    else url.searchParams.set("face", rackFace);
    const vid = vlanId();
    if (vid === null) url.searchParams.delete("vlan");
    else url.searchParams.set("vlan", vid);
    if (vlanKind.value === "any") url.searchParams.delete("vlanKind");
    else url.searchParams.set("vlanKind", vlanKind.value);
    history.replaceState(history.state, "", url);
    saveRackPreferences();
  }

  function refreshVisibleConnections() {
    refreshVlanMatches();
    filterDirectory();
    drawCableList();
    updateCableDetail();
    if (!quickPortVisible(quickSource)) quickSource = null;
    refreshQuickView();
    invalidateRoutes();
    persistViewFilters();
  }

  function updateRackFace() {
    board.dataset.rackFace = rackFace;
    gutter.hidden = rackFace !== "both";
    for (const panel of facePanels) panel.hidden = !rackFaceVisible(panel.dataset.rackFacePanel);
    for (const choice of faceChoices) {
      const active = choice.dataset.rackFaceChoice === rackFace;
      choice.setAttribute("aria-pressed", String(active));
      choice.classList.toggle("active", active);
    }
  }

  function applyRackFace(face) {
    if (busy || face === rackFace || !["front", "rear", "both"].includes(face)) return;
    const top = scroll.scrollTop;
    rackFace = face;
    clearViewInteraction();
    updateRackFace();
    drawElevations();
    refreshVisibleConnections();
    renderPortRows();
    scroll.scrollTo(0, top);
  }

  function applyDeviceFocus() {
    clearViewInteraction();
    drawElevations();
    refreshVisibleConnections();
    updateDeviceFilter();
    renderPortRows();
    scroll.scrollTo(0, 0);
    inspectorScroll.scrollTop = 0;
  }

  function applyPortRows() {
    clearViewInteraction();
    for (const [port, marker] of markers) marker.hidden = !portRowVisible(port);
    refreshVisibleConnections();
    updatePortRows();
  }

  function updateCableFocusControls() {
    editor.toggleAttribute("data-device-cable-focus", Boolean(cableFocusDevice));
    cableFocusClear.hidden = !cableFocusDevice;
    cableFocusClear.textContent = cableFocusDevice ? "Cables: " + cableFocusDevice.name + " ×" : "";
    for (const option of lines.options) {
      if (option.value === "selected" || option.value === "none") option.disabled = Boolean(cableFocusDevice);
    }
    lines.title = cableFocusDevice ? "Device focus shows all matching cables or bundles" : "";
  }

  function updateRoutingStyle() {
    const bundled = lines.value === "bundles";
    board.dataset.routingStrategy = bundled ? "pcb" : routingStrategy.value;
    routingStrategy.disabled = bundled;
    routingStrategy.title = bundled ? "Expanded bundles use PCB-style routing" : "";
  }

  function setCableFocus(device) {
    if (busy || pending || device === cableFocusDevice) return;
    const previousDevice = cableFocusDevice;
    const restoreFocus = document.activeElement === cableFocusClear;
    cableFocusDevice = device;
    clearViewInteraction();
    updateCableFocusControls();
    for (const control of board.querySelectorAll("[data-cable-focus-device]")) {
      control.setAttribute("aria-pressed", String(control.dataset.cableFocusDevice === String(device?.id)));
    }
    for (const element of editor.querySelectorAll("[data-port]")) {
      element.toggleAttribute("data-unrelated-port", dimPortForCableFocus(portAt(element)));
    }
    refreshVisibleConnections();
    if (restoreFocus && previousDevice) {
      const trigger = board.querySelector('[data-cable-focus-device="' + previousDevice.id + '"]');
      (trigger ?? deviceSummary).focus({preventScroll: true});
    }
  }

  for (const device of data.devices) {
    for (const port of device.ports) {
      ports.set(port.id, {...port, device});
      portIdsByDataset.set(String(port.id), port.id);
    }
  }
  renderDeviceOptions();
  renderPortRows();
  restoreListFields();
  viewConnections.checked = viewPreferences.connections !== false;
  viewDirectory.checked = viewPreferences.directory !== false;
  viewTrim.checked = viewPreferences.trim === true;
  viewVirtualCombine.checked = viewPreferences.virtualCombine === true;
  board.toggleAttribute("data-virtual-combine", viewVirtualCombine.checked);
  connectionsSection.open = viewPreferences.connectionsOpen !== false;
  directorySection.open = viewPreferences.directoryOpen !== false;
  restoreSelect(zoom, viewPreferences.zoom);
  restoreSelect(lines, viewPreferences.lines);
  restoreSelect(routingStrategy, viewPreferences.routingStrategy);
  updateRoutingStyle();
  updateCableFocusControls();
  restoreSelect(interfaceHighlight, viewPreferences.interfaceHighlight);
  editor.dataset.interfaceHighlightMode = interfaceHighlight.value;
  restoreSelect(portFill, viewPreferences.portFill);
  applyPortFill();
  restoreSelect(deviceImages, viewPreferences.images ?? history.state?.reRackDeviceImages);
  board.dataset.imageMode = deviceImages.value;
  applyViewOptions();
  vlanQuery.value = viewFilter("vlan");
  restoreSelect(vlanKind, viewFilter("vlanKind"));
  search.value = typeof rackPreferences.search === "string" ? rackPreferences.search : "";
  offImage.checked = rackPreferences.offImage === true;
  updateRackFace();
  drawElevations();
  refreshVlanMatches();
  drawDirectory();
  drawCableList();
  workspace.hidden = false;
  announce(idleMessage());
  refreshQuickView();
  cableFocusClear.addEventListener("click", () => setCableFocus(null));

  for (const choice of faceChoices) {
    choice.addEventListener("click", () => applyRackFace(choice.dataset.rackFaceChoice));
  }
  for (const control of quickButtons) {
    control.addEventListener("click", () => changeQuickMode(control.dataset.quickMode));
  }
  quickApply.addEventListener("click", applyQuickQueue);
  quickClear.addEventListener("click", () => {
    if (!busy) clearQuickQueue();
  });
  historyUndo.addEventListener("click", () => navigateHistory(checkpoints[checkpointIndex - 1]?.sequence));
  historyRedo.addEventListener("click", () => navigateHistory(checkpoints[checkpointIndex + 1]?.sequence));
  historyOpen.addEventListener("click", showHistory);
  get("history-close").addEventListener("click", () => historyDialog.close());

  deviceOptions.addEventListener("change", (event) => {
    const input = event.target;
    if (!input.matches('input[type="checkbox"]')) return;
    const id = Number(input.value);
    if (busy) {
      input.checked = focusedDevices.has(id);
      return;
    }
    if (input.checked) focusedDevices.add(id);
    else focusedDevices.delete(id);
    applyDeviceFocus();
  });
  deviceReset.addEventListener("click", () => {
    if (busy) return;
    focusedDevices.clear();
    for (const input of deviceOptions.querySelectorAll('input[type="checkbox"]')) input.checked = false;
    applyDeviceFocus();
    deviceFilter.open = false;
    deviceSummary.focus();
  });
  rowOptions.addEventListener("change", (event) => {
    const input = event.target;
    if (!input.matches("input[data-port-row-choice]")) return;
    if (busy) {
      input.checked = !hiddenRows.has(input.value);
      return;
    }
    if (input.checked) hiddenRows.delete(input.value);
    else hiddenRows.add(input.value);
    applyPortRows();
  });
  rowOptions.addEventListener("click", (event) => {
    const only = event.target.closest("[data-only-port-row]");
    if (!only || busy) return;
    const row = rowById.get(only.dataset.onlyPortRow);
    for (const other of portRows) {
      if (other.deviceId !== row.deviceId || other.rackFace !== row.rackFace) continue;
      if (other.id === row.id) hiddenRows.delete(other.id);
      else hiddenRows.add(other.id);
    }
    applyPortRows();
  });
  rowReset.addEventListener("click", () => {
    if (busy) return;
    hiddenRows.clear();
    applyPortRows();
    rowFilter.open = false;
    if (rowFilter.hidden) deviceSummary.focus();
    else rowSummary.focus();
  });
  for (const [filter, summary] of [[deviceFilter, deviceSummary], [rowFilter, rowSummary], [viewOptions, viewSummary]]) {
    document.addEventListener("click", (event) => {
      if (filter.open && !filter.contains(event.target)) filter.open = false;
    });
    filter.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !filter.open) return;
      event.preventDefault();
      event.stopPropagation();
      filter.open = false;
      summary.focus();
    });
  }
  for (const [key, control] of listFields) {
    control.addEventListener("change", () => {
      const [kind, field] = key.split(":");
      for (const element of editor.querySelectorAll("[data-" + kind + '-value="' + field + '"]')) {
        element.hidden = !control.checked;
      }
      try {
        localStorage.setItem(listFieldsKey, JSON.stringify(Object.fromEntries(
          Array.from(listFields, ([fieldKey, input]) => [fieldKey, input.checked]),
        )));
      } catch {
        // The visible columns still change if browser storage is unavailable.
      }
    });
  }
  vlanQuery.addEventListener("input", applyVlanFilter);
  portFill.addEventListener("change", () => {
    hideWireTooltip();
    applyPortFill();
    saveViewPreferences();
  });
  get("vlan-color-settings").addEventListener("click", openVlanColorSettings);
  get("vlan-color-add").addEventListener("click", () => addVlanColorRule(null, true));
  get("vlan-color-cancel").addEventListener("click", () => vlanColorDialog.close());
  vlanColorDialog.addEventListener("close", () => viewSummary.focus({preventScroll: true}));
  vlanColorFallbackEnabled.addEventListener("change", () => {
    vlanColorFallback.disabled = !vlanColorFallbackEnabled.checked;
  });
  vlanColorForm.addEventListener("submit", saveVlanColorSettings);
  vlanKind.addEventListener("change", applyVlanFilter);
  vlanClear.addEventListener("click", () => {
    vlanQuery.value = "";
    vlanKind.value = "any";
    applyVlanFilter();
    vlanQuery.focus();
  });
  const changeDirectoryView = () => {
    filterDirectory();
    saveRackPreferences();
  };
  search.addEventListener("input", changeDirectoryView);
  offImage.addEventListener("change", changeDirectoryView);
  lines.addEventListener("change", () => {
    if (lines.value === "bundles") selectCable(null);
    updateRoutingStyle();
    hideWireTooltip();
    applyElevationSpacing();
    invalidateRoutes();
    saveViewPreferences();
  });
  bundleClear.addEventListener("click", () => chooseBundle(null, true));
  routingStrategy.addEventListener("change", () => {
    updateRoutingStyle();
    hideWireTooltip();
    applyElevationSpacing();
    invalidateRoutes();
    saveViewPreferences();
  });
  interfaceHighlight.addEventListener("change", () => {
    editor.dataset.interfaceHighlightMode = interfaceHighlight.value;
    saveViewPreferences();
  });
  for (const control of [viewConnections, viewDirectory, viewTrim]) {
    control.addEventListener("change", () => {
      applyViewOptions();
      saveViewPreferences();
    });
  }
  viewVirtualCombine.addEventListener("change", () => {
    board.toggleAttribute("data-virtual-combine", viewVirtualCombine.checked);
    drawnMode = null;
    invalidateRoutes();
    saveViewPreferences();
  });
  for (const section of [connectionsSection, directorySection]) {
    section.addEventListener("toggle", saveViewPreferences);
  }
  deviceImages.addEventListener("change", setDeviceImages);
  zoom.addEventListener("change", setZoom);
  cancel.addEventListener("click", clearOperation);
  const rackResize = new ResizeObserver(invalidateRoutes);
  rackResize.observe(scroll, {box: "border-box"});
  for (const panel of [editor.querySelector(".re-rack-toolbar"), bundlePanel]) {
    if (panel) rackResize.observe(panel, {box: "border-box"});
  }
  const resizeFit = () => {
    if (zoom.value === "fit") invalidateRoutes();
  };
  window.addEventListener("resize", resizeFit);
  window.visualViewport?.addEventListener("resize", resizeFit);

  get("export-open").addEventListener("click", () => {
    hideWireTooltip();
    closeContextMenu();
    setError(exportError);
    updateExportOptions();
    exportDialog.showModal();
  });
  exportForm.addEventListener("input", updateExportOptions);
  exportForm.addEventListener("submit", exportRackPlan);
  get("export-cancel").addEventListener("click", () => exportDialog.close());
  exportDialog.addEventListener("cancel", event => {
    if (exporting) event.preventDefault();
  });

  for (const form of [createForm, editForm]) {
    for (const type of data.cableTypes) form.elements.type.add(new Option(type.label, type.value));
    for (const unit of data.cableLengthUnits) {
      const defaultUnit = unit.value === "m";
      form.elements.length_unit.add(new Option(unit.label + " (" + unit.value + ")", unit.value, defaultUnit, defaultUnit));
    }
    form.addEventListener("click", (event) => {
      const swatch = event.target.closest("[data-color-value]");
      if (swatch) form.elements.color.value = swatch.dataset.colorValue;
    });
  }
  for (const status of data.cableStatuses ?? []) editForm.elements.status.add(new Option(status.label, status.value));
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!createAction || busy) return;
    save({
      ...connectionBody(createAction),
      label: createForm.elements.label.value.trim(),
      color: createForm.elements.color.value.replace(/^#/, ""),
      type: createForm.elements.type.value,
      ...cableLengthValues(createForm),
    }, createError);
  });
  get("create-cancel").addEventListener("click", () => createDialog.close());
  createDialog.addEventListener("close", () => {
    createAction = null;
    clearOperation();
  });

  editForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!editingCable || busy) return;
    const changes = Object.entries(cableEditValues()).filter(([name, value]) => value !== editInitialValues[name]);
    if (!changes.length) editDialog.close();
    else save({action: "update", cable_id: editingCable.id, ...Object.fromEntries(changes)}, editError);
  });
  get("edit-close").addEventListener("click", () => editDialog.close());
  editDialog.addEventListener("close", () => {
    editingCable = null;
    editInitialValues = null;
  });

  moveForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending) save(connectionBody(pending), moveError);
  });
  get("move-cancel").addEventListener("click", () => moveDialog.close());
  moveDialog.addEventListener("close", clearOperation);

  get("modal-close").addEventListener("click", () => closeDetails(detailsDialog));
  get("port-modal-close").addEventListener("click", () => closeDetails(portDialog));
  deleteButton.addEventListener("click", async () => {
    if (!inlineEditors.has(detailsDialog) || await inlineEditors.get(detailsDialog).flush()) showDeleteConfirm(true);
  });
  deleteCancel.addEventListener("click", () => {
    setError(detailsError);
    showDeleteConfirm(false);
    deleteButton.focus();
  });
  deleteYes.addEventListener("click", async () => {
    if (inlineEditors.has(detailsDialog) && !await inlineEditors.get(detailsDialog).flush()) return;
    if (selectedCable?.deletable && detailsDialog.open) save({action: "delete", cable_id: selectedCable.id}, detailsError);
  });
  for (const dialog of [detailsDialog, portDialog]) {
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      closeDetails(dialog);
    });
    dialog.addEventListener("close", () => inlineEditors.delete(dialog));
  }
  for (const dialog of [createDialog, editDialog, moveDialog, historyDialog]) {
    dialog.addEventListener("cancel", (event) => {
      if (busy) event.preventDefault();
    });
  }
  for (const dialog of editor.querySelectorAll("dialog")) {
    dialog.addEventListener("close", () => {
      if (selectedCable && !editor.querySelector("dialog[open]")) selectCable(null);
    });
  }

  window.addEventListener("resize", hideWireTooltip);
  window.addEventListener("blur", hideWireTooltip);
  window.addEventListener("scroll", hideWireTooltip, {passive: true});
  scroll.addEventListener("scroll", hideWireTooltip);
  editor.addEventListener("pointerleave", hideWireTooltip);
  inspectorScroll.addEventListener("scroll", hideWireTooltip);

  editor.addEventListener("contextmenu", openContextMenu);
  contextMenu.addEventListener("contextmenu", (event) => event.preventDefault());
  document.addEventListener("pointerdown", (event) => {
    if (!contextMenu.contains(event.target)) closeContextMenu();
  });
  for (const panel of [window, scroll, inspectorScroll]) {
    panel.addEventListener("scroll", () => closeContextMenu(true), {passive: true});
  }
  window.addEventListener("resize", () => closeContextMenu(true));
  contextMenu.addEventListener("keydown", (event) => {
    if (event.key === "Tab" || event.key === "Escape") {
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      closeContextMenu(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(contextMenu.querySelectorAll("[role=menuitem]"));
    const index = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  });

  editor.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    hideWireTooltip();
    if (!portAt(event.target)) finishPortClick(quickMode !== "normal");
    const port = portAt(event.target) ?? wirePortAt(event);
    if (!port || !canStart(port)) return;
    gesture = {port, id: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false};
  });

  window.addEventListener("pointermove", (event) => {
    if (!gesture || event.pointerId !== gesture.id) {
      queueWireTooltip(event);
      return;
    }
    if (!gesture.moved) {
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 5) return;
      finishPortClick();
      for (const filter of [viewOptions, deviceFilter, rowFilter]) filter.open = false;
      gesture.moved = true;
      // The rack stays mounted while wire graphics are replaced during the drag.
      editor.setPointerCapture(event.pointerId);
      chooseSource(gesture.port);
    }
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    trackDragTarget();
    scheduleDraw();
    if (!scrollFrame) scrollFrame = requestAnimationFrame(scrollWhileDragging);
  });

  window.addEventListener("pointerup", (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const moved = gesture.moved;
    // Resolve the hit while the current drop marker is still enlarged.
    const target = moved ? portAtPoint(event.clientX, event.clientY) : null;
    gesture = null;
    dropTarget = null;
    if (!moved) return;
    suppressClick = true;
    updateMarks();
    if (target && (quickMode === "normal" || validTarget(target))) {
      useTarget(target);
    } else if (quickMode === "normal") {
      announce("No port selected. Choose a free port or cancel.");
    } else {
      clearOperation();
      announce("Drop on a free port that is not queued.", true);
    }
  });

  function cancelGesture(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const moved = gesture.moved;
    gesture = null;
    if (moved) clearOperation();
  }

  window.addEventListener("pointercancel", cancelGesture);
  editor.addEventListener("lostpointercapture", (event) => {
    if (event.target === editor) cancelGesture(event);
  });

  editor.addEventListener("click", (event) => {
    if (busy || pending || (suppressClick && event.detail > 0)) return;
    const port = portAt(event.target);
    if (port) {
      if (event.detail > 1 && pendingPortClick?.port.id === port.id) return;
      finishPortClick(pendingPortClick?.port.id !== port.id);
      if (event.detail === 0) activatePort(port);
      else if (!editor.querySelector("dialog[open]")) {
        // Give a pointer double-click priority over opening a cable dialog or changing the quick queue.
        const timer = setTimeout(() => finishPortClick(true), 500);
        pendingPortClick = {port, timer, control: event.target.closest("[data-port]")};
      }
      return;
    }
    if (quickMode !== "normal") return;
    const clickedCable = cableAt(event);
    if (clickedCable) openCableDetails(clickedCable);
  });

  editor.addEventListener("dblclick", (event) => {
    const port = portAt(event.target);
    if (!port || suppressClick) return;
    event.preventDefault();
    openPortDetails(port);
  });

  window.addEventListener("keydown", (event) => {
    if (!gesture?.moved || event.key.toLowerCase() !== "i" || event.isComposing ||
        event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    deviceImages.selectedIndex = (deviceImages.selectedIndex + 1) % deviceImages.options.length;
    setDeviceImages();
    announce("Device images: " + deviceImages.selectedOptions[0].textContent + ".");
  }, {capture: true});

  editor.addEventListener("keydown", (event) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      openContextMenu(event, true);
      return;
    }
    if (event.key !== "Escape" || busy ||
        createDialog.open || editDialog.open || moveDialog.open || detailsDialog.open || historyDialog.open ||
        exportDialog.open || vlanColorDialog.open || portDialog.open) return;
    finishPortClick();
    if (quickSource && !gesture?.moved && !source && !pending) {
      event.preventDefault();
      quickSource = null;
      refreshQuickView();
      return;
    }
    if (!source && !pending) {
      if (expandedBundle) {
        event.preventDefault();
        chooseBundle(null, true);
      }
      return;
    }
    event.preventDefault();
    if (gesture && editor.hasPointerCapture(gesture.id)) editor.releasePointerCapture(gesture.id);
    gesture = null;
    const previousSource = source;
    clearOperation();
    const control = visibleMarker(previousSource?.id) ??
      directory.querySelector('.re-rack-directory-device:not([hidden]) .re-rack-directory-entry:not([hidden]) [data-port="' +
        previousSource?.id + '"]');
    control?.focus({preventScroll: true});
  });

  const restore = history.state?.reRackEditor;
  if (restore) {
    history.replaceState({...history.state, reRackEditor: null}, "");
    if (restore.queue && quickMode !== "normal") {
      for (const id of restore.queue.deletes) stagedDeletes.add(id);
      for (const operation of restore.queue.connections) {
        stagedConnections.set(operation.source, operation);
        stagedByPort.set(operation.source, operation);
        stagedByPort.set(operation.target, operation);
      }
      preferredSourceDevice = restore.queue.preferredSourceDevice;
      refreshQuickView();
    }
    restoreSelect(zoom, restore.zoom);
    restoreSelect(lines, restore.lines);
    offImage.checked = restore.offImage ?? offImage.checked;
    search.value = restore.search ?? "";
    filterDirectory();
    setZoom();
    requestAnimationFrame(() => scroll.scrollTo(restore.left, restore.top));
    if (restore.message) announce(restore.message);
  } else {
    setZoom();
  }
  saveRackPreferences();
})();
