(() => {
  "use strict";

  const editor = document.querySelector("[data-global-view-designer]");
  if (!editor) return;
  const data = JSON.parse(document.getElementById("re-global-views-data").textContent);
  const httpUrl = globalThis.NbCableEditorHttpUrl;
  const get = key => editor.querySelector("[data-" + key + "]");
  const form = get("global-view-form");
  const record = get("record");
  const name = get("name");
  const showInToolbar = get("show-in-toolbar");
  const isDefault = get("is-default");
  const summary = get("preview-summary");
  const results = get("preview-results");
  const previous = get("previous");
  const next = get("next");
  const deletePanel = get("delete-panel");
  const error = get("error");
  const status = get("status");
  const filterRack = get("filter-rack");
  const filterSection = get("global-filters");
  const filterSummary = get("filter-summary");
  const filterPreview = get("global-filter-preview");
  const filterFrame = get("filter-preview-frame");
  const filterPreviewStatus = get("filter-preview-status");
  const filterApi = globalThis.NbCableEditorConnectionFilter;
  const ruleApi = globalThis.NbCableEditorRules;
  const ruleEditor = globalThis.NbCableEditorRuleEditor;
  const ruleKinds = {
    connectionRules: {kind: "connection", label: "Connection Rules", legacy: "connectionFilter"},
    interfaceRules: {kind: "interface", label: "Interface Rules", legacy: "portFilter"},
    deviceRules: {kind: "device", label: "Device Rules"},
  };
  const filterButtons = {
    connectionRules: get("edit-connection-filter"),
    interfaceRules: get("edit-port-filter"),
    deviceRules: get("edit-device-rules"),
  };
  const manageFilters = data.features.connectionFilter !== false && filterSection && filterApi && ruleApi && ruleEditor;
  const fieldChoices = {};
  const displayFields = new Map();
  const toolbarFields = new Map();
  const rackSpecificFields = ["devices", "cableDevice", "hiddenRows", "deviceGaps", "expandedBundle"];
  let views = data.views;
  let current = null;
  let baseSettings = {};
  let captured = false;
  let preview = null;
  let previewSequence = 0;
  let previewTimer;
  let saving = false;
  let filterRequest;
  let filterEditors;
  let filterRackChosen = false;
  let drawingPreview;
  let drawingPreviewId = 0;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function selectField(parent, label, options, defaultLabel = "Use system value") {
    const field = node("label", "d-grid gap-1");
    const control = node("select", "form-select form-select-sm no-ts");
    control.add(new Option(defaultLabel, ""));
    for (const [value, text] of options) control.add(new Option(text, value));
    field.append(node("span", "form-label mb-0", label), control);
    parent.append(field);
    return control;
  }

  function textField(parent, label, length) {
    const field = node("label", "d-grid gap-1");
    const control = node("input", "form-control form-control-sm");
    control.type = "text";
    control.maxLength = length;
    field.append(node("span", "form-label mb-0", label), control);
    parent.append(field);
    return control;
  }

  function createScope(key, label) {
    const details = node("details", "re-global-targets");
    const heading = node("summary", "", label);
    const search = node("input", "form-control form-control-sm my-2");
    search.type = "search";
    search.placeholder = "Find " + label.toLowerCase();
    search.setAttribute("aria-label", search.placeholder);
    const list = node("div", "re-global-target-options");
    const options = data.choices[key].map(choice => {
      const row = node("label", "form-check mb-0");
      const box = node("input", "form-check-input");
      box.type = "checkbox";
      box.value = String(choice.id);
      box.dataset.scopeTarget = key;
      row.append(box, node("span", "form-check-label", choice.name));
      list.append(row);
      return {row, box, choice};
    });
    const empty = node("p", "text-secondary small mb-0", "No matching " + label.toLowerCase() + ".");
    details.append(heading, search, list, empty);
    get("scope-fields").append(details);
    search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      for (const item of options) item.row.hidden = !item.choice.name.toLowerCase().includes(query);
      empty.hidden = options.some(item => !item.row.hidden);
    });
    empty.hidden = Boolean(options.length);
    search.disabled = !options.length;
    fieldChoices[key] = {label, heading, options};
  }

  for (const [key, label] of [["sites", "Sites"], ["racks", "Racks"], ["roles", "Rack roles"], ["tags", "Rack tags"]]) {
    createScope(key, label);
  }

  const display = get("display-fields");
  const onOff = [["true", "On"], ["false", "Off"]];
  for (const [group, key, label, choices] of [
    ["rack", "face", "Rack side", [["front", "Front"], ["rear", "Rear"], ["both", "Both"]]],
    ["display", "zoom", "Zoom", data.zoomChoices],
    ["display", "lines", "Lines", [
      ["all", "All"], ["bundles", "Bundles"], ["selected", "Selected only"], ["filtered", "Filtered connections only"], ["none", "Hidden"],
    ]],
    ["display", "images", "Device images", [["visible", "Visible"], ["faded", "50% opacity"], ["hidden", "Hidden"]]],
    ["display", "routingStrategy", "Routing strategy", [["balanced", "Balanced"], ["pcb", "PCB-style"]]],
    ["display", "portFill", "Port fill", [["status", "Connection status"], ["vlan", "Untagged VLAN"]]],
    ["display", "interfaceHighlight", "Interface highlighting", [["all", "All"], ["free", "Highlight free"], ["used", "Highlight used"]]],
    ["display", "connections", "Connections panel", onOff],
    ["display", "directory", "Interface directory", onOff],
    ["display", "connectionsOpen", "Connections expanded", onOff],
    ["display", "directoryOpen", "Interface directory expanded", onOff],
    ["display", "trim", "Trim width to visible ports", onOff],
    ["display", "compactEmptyUnits", "Compact empty rack units", onOff],
    ["display", "virtualCombine", "Virtual combine", onOff],
    ["display", "externalLocations", "External cable locations", onOff],
    ...Object.entries(data.traceDestinationFeatures ?? {}).filter(([key]) => data.features[key] !== false)
      .map(([key, label]) => ["display", key, label, onOff]),
    ["rack", "positionIndicator", "Position indicator", onOff],
    ["rack", "offImage", "Only ports outside elevations", onOff],
  ]) {
    if ((key === "externalLocations" || key === "compactEmptyUnits") && data.features[key] === false) continue;
    const control = selectField(display, label, choices);
    control.dataset.viewSetting = key;
    displayFields.set(control, {group, key, boolean: choices === onOff});
  }
  if (data.features.vlan !== false) {
    displayFields.set(textField(display, "VLAN filter", 1024), {group: "rack", key: "vlan"});
    const control = selectField(display, "VLAN membership", [
      ["any", "Any"], ["untagged", "Untagged"], ["tagged", "Tagged"],
    ]);
    displayFields.set(control, {group: "rack", key: "vlanKind"});
  }

  for (const [key, label] of Object.entries(data.toolbarFeatures)) {
    if (data.features[key] === false) continue;
    const control = selectField(get("toolbar-fields"), label, [["true", "Show"], ["false", "Hide"]], "Use toolbar default");
    toolbarFields.set(control, key);
  }

  async function request(body, signal) {
    const url = httpUrl(data.url);
    const csrf = form.elements.csrfmiddlewaretoken?.value;
    if (!url || !csrf) throw new Error("The designer could not start this request.");
    const response = await fetch(url, {
      method: "POST",
      mode: "same-origin",
      headers: {"Content-Type": "application/json", "Accept": "application/json", "X-CSRFToken": csrf},
      body: JSON.stringify(body),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The request could not be completed.");
    return payload;
  }

  function allRacks() {
    return form.elements["re-global-scope"].value === "all";
  }

  function scope() {
    const all = allRacks();
    const selections = Object.entries(fieldChoices).map(([key, field]) => [
      key, all ? [] : field.options.filter(item => item.box.checked).map(item => item.choice.id),
    ]);
    return {all, ...Object.fromEntries(selections)};
  }

  function refreshScopeControls() {
    get("scopes").hidden = allRacks();
    for (const field of Object.values(fieldChoices)) {
      const count = field.options.filter(item => item.box.checked).length;
      field.heading.textContent = count ? field.label + " (" + count + ")" : field.label;
    }
  }

  function renderPreview(payload) {
    preview = payload;
    results.replaceChildren();
    for (const rack of payload.racks) {
      const row = node("li", "list-group-item px-0");
      const url = httpUrl(rack.url);
      const title = node(url ? "a" : "span", "", rack.name);
      if (url) title.href = url;
      row.append(title);
      if (rack.site) row.append(node("span", "text-secondary small ms-2", rack.site));
      results.append(row);
    }
    summary.textContent = payload.count
      ? payload.count + " matching " + (payload.count === 1 ? "rack" : "racks") + " you can view"
        + (payload.count > payload.pageSize ? " · Showing " + (payload.offset + 1) + "–"
          + (payload.offset + payload.racks.length) : "")
      : "No visible racks match this scope.";
    previous.disabled = payload.offset === 0;
    next.disabled = payload.offset + payload.pageSize >= payload.count;
    get("pagination").hidden = payload.count <= payload.pageSize;
    if (manageFilters && !filterRackChosen && !filterRequest && !filterEditors && payload.offset === 0) {
      selectFilterRack(payload.racks[0]?.id ?? data.choices.racks[0]?.id);
    }
  }

  async function refreshPreview(offset = 0) {
    clearTimeout(previewTimer);
    const sequence = ++previewSequence;
    summary.textContent = "Checking rack scope…";
    get("preview").setAttribute("aria-busy", "true");
    try {
      const payload = await request({action: "preview", id: current?.id, scope: scope(), offset});
      if (sequence === previewSequence) renderPreview(payload);
    } catch (failure) {
      if (sequence !== previewSequence) return;
      summary.textContent = failure.message;
      results.replaceChildren();
      get("pagination").hidden = true;
    } finally {
      if (sequence === previewSequence) get("preview").removeAttribute("aria-busy");
    }
  }

  function queuePreview() {
    refreshScopeControls();
    clearTimeout(previewTimer);
    ++previewSequence;
    previewTimer = setTimeout(refreshPreview, 150);
  }

  function updateSource() {
    const hasRackDetails = rackSpecificFields.some(key => {
      const value = baseSettings.rack?.[key];
      return value && (typeof value !== "object" || Object.keys(value).length > 0);
    }) || baseSettings.selectedConnections?.length;
    const filters = [];
    if (!manageFilters && (baseSettings.connectionRules?.length || baseSettings.connectionFilter?.children?.length)) filters.push("connection rules");
    if (!manageFilters && (baseSettings.interfaceRules?.length || baseSettings.portFilter?.children?.length)) filters.push("interface rules");
    if (!manageFilters && baseSettings.deviceRules?.length) filters.push("device rules");
    const parts = [];
    if (captured) parts.push("Settings copied from the rack editor.");
    if (filters.length) parts.push("Includes " + filters.join(" and ") + ".");
    if (hasRackDetails) parts.push("Device, port row, gap and cable selections refer to specific racks.");
    get("source-message").textContent = parts.join(" ");
    get("source").hidden = !parts.length;
    get("clear-rack-settings").hidden = !hasRackDetails;
  }

  function rulesFor(key) {
    const definition = ruleKinds[key];
    return ruleApi.normalize(definition.kind, baseSettings[key], {
      legacyFilter: baseSettings[definition.legacy], legacyAction: baseSettings.portFilterAction,
    });
  }

  function describeFilters() {
    if (!manageFilters) return;
    const counts = Object.entries(ruleKinds).map(([key, {label}]) => {
      const count = rulesFor(key).length;
      return label + " (" + count + ")";
    });
    filterSummary.textContent = counts.join(" · ");
  }

  function setRules(key, rules) {
    baseSettings[key] = rules;
    if (ruleKinds[key].legacy) delete baseSettings[ruleKinds[key].legacy];
    if (key === "interfaceRules") delete baseSettings.portFilterAction;
    describeFilters();
  }

  function filterCatalog(context) {
    const traceEndpoints = context.filterTraceEndpoints;
    function resolve(record) {
      if (!record.filterTrace) return record;
      const filterTrace = Object.fromEntries(Object.entries(record.filterTrace).map(([scope, ids]) =>
        [scope, ids.map(id => traceEndpoints[id]).filter(Boolean)]));
      return {...record, filterTrace};
    }
    const ports = context.devices.flatMap(device =>
      device.ports.map(port => ({...resolve(port), device})));
    const byId = new Map(ports.map(port => [port.id, port]));
    return {
      ports, devices: context.devices, cables: context.cables.map(resolve), cableTypes: context.cableTypes,
      endpoint(cable, end) {
        const remote = cable["endpoint" + end];
        return byId.get(cable[end.toLowerCase()]) ?? (remote ? filterApi.endpointPort(remote) : null);
      },
    };
  }

  function resetDrawingPreview() {
    if (!drawingPreview) return;
    clearTimeout(drawingPreview.timer);
    drawingPreview = null;
    filterPreview.close();
    filterFrame.removeAttribute("src");
  }

  function showDrawingPreview(kind, rules, context) {
    const url = httpUrl(context.previewUrl);
    if (!url) {
      filterEditors[kind].resume();
      return;
    }
    const draft = settings();
    draft[kind] = rules;
    const state = {kind, rackId: context.rackId, requestId: ++drawingPreviewId, settings: draft};
    drawingPreview = state;
    filterPreviewStatus.textContent = "Loading rack preview…";
    filterFrame.style.visibility = "hidden";
    filterPreview.showModal();
    state.timer = setTimeout(() => {
      if (drawingPreview === state) filterPreviewStatus.textContent = "The rack preview could not be loaded.";
    }, 18000);
    filterFrame.src = url;
  }

  function clearFilterContext() {
    filterRequest?.abort();
    filterRequest = null;
    for (const button of Object.values(filterButtons)) button.disabled = false;
    for (const dialog of Object.values(filterEditors ?? {})) dialog.destroy();
    filterEditors = null;
  }

  function selectFilterRack(id) {
    const value = id == null ? "" : String(id);
    if (filterRack.value === value) return;
    filterRack.value = value;
    clearFilterContext();
  }

  async function openFilter(kind) {
    if (saving) return;
    if (filterEditors) {
      filterEditors[kind].open();
      return;
    }
    const controller = new AbortController();
    filterRequest = controller;
    for (const button of Object.values(filterButtons)) button.disabled = true;
    filterSummary.textContent = "Loading filter choices…";
    try {
      const context = await request({action: "filter-catalog", rackId: Number(filterRack.value) || null}, controller.signal);
      if (filterRequest !== controller) return;
      const catalog = filterCatalog(context);
      const lookups = Object.fromEntries(filterApi.criteriaFields.map(field => [field, ({query, ids}, signal) =>
        request({action: "filter-choices", field, query, ids}, signal)]));
      const options = {
        rackId: context.rackId, locationId: context.locationId, siteId: context.siteId,
        vlan: data.features.vlan !== false, destinationUrls: context.filterDestinationUrls,
        getCatalog: () => catalog, lookups, excludeCurrentRack: false, onPreviewEnd: resetDrawingPreview,
      };
      const build = (key, element) => ruleEditor.createDialog({
        ...options, kind: ruleKinds[key].kind, dialog: element,
        getRules: () => rulesFor(key),
        onApply: rules => setRules(key, rules),
        onPreview: context.previewUrl ? rules => showDrawingPreview(key, rules, context) : undefined,
      });
      filterEditors = {
        connectionRules: build("connectionRules", get("connection-filter-dialog")),
        interfaceRules: build("interfaceRules", get("port-filter-dialog")),
        deviceRules: build("deviceRules", get("device-rules-dialog")),
      };
      describeFilters();
      filterEditors[kind].open();
    } catch (failure) {
      if (filterRequest === controller) filterSummary.textContent = failure.message;
    } finally {
      if (filterRequest === controller) {
        filterRequest = null;
        for (const button of Object.values(filterButtons)) button.disabled = false;
      }
    }
  }

  if (manageFilters) {
    filterRack.add(new Option("No preview rack", ""));
    for (const rack of data.choices.racks) filterRack.add(new Option(rack.name, String(rack.id)));
    filterSection.hidden = false;
    filterRack.addEventListener("change", () => {
      filterRackChosen = true;
      clearFilterContext();
      describeFilters();
    });
    for (const [kind, button] of Object.entries(filterButtons)) {
      button.addEventListener("click", () => void openFilter(kind));
    }
    get("filter-preview-back").addEventListener("click", () => {
      if (drawingPreview) filterEditors[drawingPreview.kind].resume();
    });
    const cancelPreview = () => {
      if (!drawingPreview) return;
      const {kind} = drawingPreview;
      filterEditors[kind].cancelPreview();
      filterButtons[kind].focus();
    };
    get("filter-preview-cancel").addEventListener("click", cancelPreview);
    filterPreview.addEventListener("cancel", event => {
      event.preventDefault();
      cancelPreview();
    });
    window.addEventListener("message", event => {
      const state = drawingPreview;
      if (!state || event.origin !== location.origin || event.source !== filterFrame.contentWindow ||
          event.data?.rackId !== state.rackId) return;
      if (event.data.type === "nbcableeditor:global-preview-ready") {
        event.source.postMessage({type: "nbcableeditor:global-preview-settings", requestId: state.requestId,
          settings: state.settings}, location.origin);
      } else if (event.data.type === "nbcableeditor:global-preview-applied" && event.data.requestId === state.requestId) {
        clearTimeout(state.timer);
        filterPreviewStatus.textContent = "";
        filterFrame.style.visibility = "";
      }
    });
  }

  function updateRecordOptions() {
    record.replaceChildren(new Option("New global view", ""));
    for (const view of views) record.add(new Option(view.name, String(view.id)));
    record.value = current ? String(current.id) : "";
  }

  function showView(view, draft) {
    current = view ?? null;
    baseSettings = structuredClone(draft?.settings ?? view?.settings ?? {});
    captured = Boolean(draft);
    name.value = draft?.name || view?.name || "";
    showInToolbar.checked = view?.showInToolbar === true;
    isDefault.checked = view?.isDefault === true;
    const targetScope = view?.scope ?? (draft?.rackId ? {all: false, racks: [draft.rackId]} : {all: true});
    form.elements["re-global-scope"].value = targetScope.all ? "all" : "selected";
    for (const [key, field] of Object.entries(fieldChoices)) {
      const selected = new Set(targetScope[key]);
      for (const {box, choice} of field.options) box.checked = selected.has(choice.id);
    }
    for (const [control, {group, key}] of displayFields) {
      let value = baseSettings[group]?.[key] === undefined ? "" : String(baseSettings[group][key]);
      if (key === "zoom" && value === "fit") value = "horizontal-fit";
      if (key === "zoom" && value && !Array.from(control.options).some(option => option.value === value)) {
        const scale = Number(value);
        if (Number.isFinite(scale)) {
          control.add(new Option(Math.round(scale / (data.zoomReferenceScale ?? 1) * 100) + "%", value));
        }
      }
      control.value = value;
    }
    for (const [control, key] of toolbarFields) {
      const value = baseSettings.toolbar?.[key];
      control.value = typeof value === "boolean" ? String(value) : "";
    }
    get("delete").hidden = !current;
    deletePanel.hidden = true;
    error.hidden = true;
    status.textContent = "";
    updateRecordOptions();
    updateSource();
    if (manageFilters) {
      filterRackChosen = Boolean(draft?.rackId);
      clearFilterContext();
      filterRack.value = String(draft?.rackId ?? data.choices.racks[0]?.id ?? "");
      describeFilters();
    }
    queuePreview();
  }

  function settings() {
    const result = structuredClone(baseSettings);
    for (const [control, {group, key, boolean}] of displayFields) {
      const fields = result[group] ??= {};
      if (control.value) fields[key] = boolean ? control.value === "true" : control.value;
      else delete fields[key];
    }
    const toolbar = result.toolbar ??= {};
    for (const [control, key] of toolbarFields) {
      if (control.value) toolbar[key] = control.value === "true";
      else delete toolbar[key];
    }
    return result;
  }

  async function mutate(action) {
    if (saving) return;
    saving = true;
    const controls = [get("save"), get("delete"), get("confirm-delete"), record, showInToolbar, isDefault];
    for (const control of controls) control.disabled = true;
    error.hidden = true;
    try {
      const body = action === "delete" ? {action, id: current.id, revision: current.revision}
        : {action, id: current?.id, revision: current?.revision, name: name.value.trim(), scope: scope(), settings: settings(),
          showInToolbar: showInToolbar.checked, isDefault: isDefault.checked};
      const payload = await request(body);
      views = payload.views;
      showView(views.find(view => view.id === payload.viewId));
      status.textContent = action === "delete" ? "Global view deleted." : "Global view saved.";
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      saving = false;
      for (const control of controls) control.disabled = false;
    }
  }

  record.addEventListener("change", () => showView(views.find(view => String(view.id) === record.value)));
  form.addEventListener("change", event => {
    if (event.target.name === "re-global-scope" || event.target.hasAttribute("data-scope-target")) queuePreview();
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    void mutate(current ? "save" : "create");
  });
  get("delete").addEventListener("click", () => {
    if (!current) return;
    get("delete-message").textContent = "Delete “" + current.name + "” from every rack?";
    deletePanel.hidden = false;
    get("cancel-delete").focus();
  });
  get("confirm-delete").addEventListener("click", () => void mutate("delete"));
  get("cancel-delete").addEventListener("click", () => {
    deletePanel.hidden = true;
    get("delete").focus();
  });
  get("clear-rack-settings").addEventListener("click", () => {
    for (const key of rackSpecificFields) delete baseSettings.rack?.[key];
    delete baseSettings.selectedConnections;
    for (const [control, {key}] of displayFields) {
      if (key === "lines" && control.value === "selected") control.value = "all";
    }
    updateSource();
  });
  get("refresh-preview").addEventListener("click", () => void refreshPreview());
  previous.addEventListener("click", () => void refreshPreview(Math.max(0, preview.offset - preview.pageSize)));
  next.addEventListener("click", () => void refreshPreview(preview.offset + preview.pageSize));

  let draft;
  try {
    const key = "nbcableeditor:global-view-draft";
    draft = JSON.parse(sessionStorage.getItem(key) || "null");
    sessionStorage.removeItem(key);
  } catch {
    // The standalone designer remains available without browser storage.
  }
  form.hidden = false;
  get("preview").hidden = false;
  showView(views.find(view => view.id === draft?.id), draft);
})();
