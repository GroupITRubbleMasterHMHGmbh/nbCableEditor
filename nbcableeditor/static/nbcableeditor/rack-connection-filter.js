(() => {
  "use strict";

  const MAX_DEPTH = 8;
  const MAX_NODES = 100;
  const MAX_VALUES = 1000;
  const MAX_TEXT = 1024;
  const MAX_LENGTH = 1e12;
  const LENGTH_METERS = new Map([
    ["km", 1000], ["m", 1], ["cm", .01], ["mi", 1609.344], ["ft", .3048], ["in", .0254],
  ]);
  const ENDPOINTS = [["any", "Either end"], ["both", "Both ends"], ["a", "End A"], ["b", "End B"]];
  const MEMBERSHIPS = [["any", "Tagged or untagged"], ["tagged", "Tagged"], ["untagged", "Untagged"]];
  const VLAN_MODES = [
    ["access", "Access"], ["tagged", "Tagged"], ["tagged-all", "Tagged (all)"], ["q-in-q", "Q-in-Q"],
    ["", "Unconfigured"],
  ];
  const LOCATIONS = [
    ["within-rack", "Both ends in this rack"], ["outside-rack", "One end outside this rack"],
    ["other-rack", "To another rack"], ["other-site", "To another site"],
    ["selected-racks", "To selected racks"], ["selected-sites", "To selected sites"],
  ];
  const TRACE_GEOGRAPHY = [
    ["end-outside-rack", "Trace ends outside this rack", "rackId"],
    ["end-outside-location", "Trace ends outside this location", "locationId"],
    ["end-outside-site", "Trace ends outside this site", "siteId"],
    ["end-in-current-rack", "Trace ends in this rack", "rackId"],
    ["end-in-current-location", "Trace ends in this location", "locationId"],
    ["end-in-current-site", "Trace ends in this site", "siteId"],
    ["end-in-racks", "Trace ends in selected racks", "rackId", "racks"],
    ["end-in-locations", "Trace ends in selected locations", "locationId", "locations"],
    ["end-in-sites", "Trace ends in selected sites", "siteId", "sites"],
    ["along-current-rack", "Trace runs through this rack", "rackId"],
    ["along-current-location", "Trace runs through this location", "locationId"],
    ["along-current-site", "Trace runs through this site", "siteId"],
    ["along-racks", "Trace runs through selected racks", "rackId", "racks"],
    ["along-locations", "Trace runs through selected locations", "locationId", "locations"],
    ["along-sites", "Trace runs through selected sites", "siteId", "sites"],
    ["along-racks-in-locations", "Trace runs through racks in selected locations", "rackLocationId", "locations"],
  ];
  const TRACE_GEOGRAPHY_SCOPES = Object.fromEntries(TRACE_GEOGRAPHY.map(([scope, , , catalog = null]) => [scope, catalog]));
  const TRACE_SCOPES = [
    ["any", "Any device along the trace"], ["next", "Next device along the trace"],
    ...TRACE_GEOGRAPHY.map(([scope, label]) => [scope, label]),
  ];
  const DEVICE_FIELDS = [
    ["devices", "Devices"], ["deviceTypes", "Device types"], ["deviceRoles", "Device roles"],
    ["deviceTags", "Device tags"], ["deviceTypeTags", "Device type tags"], ["deviceManufacturers", "Device manufacturers"],
  ];
  const PORT_FIELDS = [
    ["interfaces", "Interfaces"], ["modules", "Installed modules"], ["moduleTypes", "Module types"],
    ["moduleTags", "Module tags"], ["moduleTypeTags", "Module type tags"], ["moduleManufacturers", "Module manufacturers"],
  ];
  const CRITERIA_FIELDS = [...DEVICE_FIELDS, ...PORT_FIELDS];
  const RULE_TYPES = [
    ["endpoint", "Device, module or port"], ["between", "Between endpoints"], ["trace", "Cable trace"],
    ["vlan", "VLAN membership"], ["vlan-mode", "VLAN mode"], ["location", "Cable location"],
    ["cable-type", "Cable type"], ["length", "Cable length"],
  ];
  const PORT_RULES = new Set(["endpoint", "trace", "vlan", "vlan-mode"]);

  function empty() {
    return {kind: "group", operator: "and", children: []};
  }

  function emptyCriteria() {
    return {portRanges: ""};
  }

  function newRule(kind) {
    switch (kind) {
      case "endpoint": return {kind, endpoint: "any", criteria: emptyCriteria()};
      case "between": return {kind, a: emptyCriteria(), b: emptyCriteria(), directional: false};
      case "trace": return {kind, scope: "any", criteria: emptyCriteria()};
      case "vlan": return {kind, endpoint: "any", membership: "any", ids: ""};
      case "vlan-mode": return {kind, endpoint: "any", values: []};
      case "location": return {kind, scope: "within-rack", values: []};
      case "cable-type": return {kind, values: []};
      case "length": return {kind, min: null, max: null};
    }
  }

  function idSet(values = []) {
    if (!Array.isArray(values) || values.length > MAX_VALUES ||
        values.some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error("A filter selection is invalid.");
    }
    return new Set(values);
  }

  function pieces(text, label) {
    if (typeof text !== "string" || text.length > MAX_TEXT) throw new Error(label + " is too long.");
    if (!text.trim()) return [];
    const entries = text.trim().split(/\s*,\s*/);
    if (entries.includes("")) throw new Error("Separate entries in " + label.toLowerCase() + " with commas.");
    return entries;
  }

  function portSelectors(text) {
    return pieces(text, "Port names and ranges").map(entry => {
      const name = entry.toLowerCase();
      if (name.startsWith("=")) {
        const exact = name.slice(1).trim();
        if (!exact) throw new Error("Enter a port name after =.");
        return port => port === exact;
      }
      const range = /^(.*?)(\d+)\s*[-–]\s*(.*?)(\d+)$/.exec(name);
      if (!range || (range[3] && range[1] !== range[3])) return port => port === name;
      const low = Number(range[2]);
      const high = Number(range[4]);
      if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low > high) {
        throw new Error("Enter a port range from the lower number to the higher number.");
      }
      const prefix = range[1];
      return port => {
        const match = /^(.*?)(\d+)$/.exec(port);
        return Boolean(match && (!prefix || prefix === match[1]) && low <= Number(match[2]) && Number(match[2]) <= high);
      };
    });
  }

  function option(id, name) {
    return id != null && name ? [{id, name}] : [];
  }

  function deviceChoices(device, key) {
    if (key === "devices") return option(device?.id ?? device?.filterDeviceId, device?.name);
    if (key === "deviceTypes") return option(device?.deviceTypeId, device?.deviceType);
    return device?.filter?.[key] ?? [];
  }

  function portChoices(port, key) {
    if (key === "interfaces") {
      const id = port.filter?.interfaceId ?? (port.kind === "interface" ? port.id : null);
      return option(id, [port.device?.name, port.name].filter(Boolean).join(" · "));
    }
    const choices = port.filter?.[key] ?? [];
    return key === "modules" && port.device?.name
      ? choices.map(({id, name}) => ({id, name: port.device.name + " · " + name}))
      : choices;
  }

  function matchingIds(port, key) {
    if (key === "devices") return [port.device?.id ?? port.device?.filterDeviceId];
    if (key === "deviceTypes") return [port.device?.deviceTypeId];
    if (key === "interfaces") return [port.filter?.interfaceId ?? (port.kind === "interface" ? port.id : null)];
    return (port.filter?.[key] ?? port.device?.filter?.[key] ?? []).map(item => item.id);
  }

  function endpointCriteria(criteria) {
    const selections = CRITERIA_FIELDS.map(([key]) => [key, idSet(criteria?.[key])]).filter(([, ids]) => ids.size);
    const ports = portSelectors(criteria?.portRanges ?? "");
    if (!selections.length && !ports.length) return null;
    return port => Boolean(port &&
      selections.every(([key, ids]) => matchingIds(port, key).some(id => ids.has(id))) &&
      (!ports.length || ports.some(matches => matches(port.name?.toLowerCase() ?? ""))));
  }

  function matchEndpoints(scope, predicate) {
    switch (scope) {
      case "any": return (_cable, a, b) => predicate(a) || predicate(b);
      case "both": return (_cable, a, b) => predicate(a) && predicate(b);
      case "a": return (_cable, a) => predicate(a);
      case "b": return (_cable, _a, b) => predicate(b);
      default: throw new Error("Choose which connection ends to match.");
    }
  }

  function vlanPredicate(rule) {
    if (!MEMBERSHIPS.some(([value]) => value === rule.membership)) throw new Error("Choose a VLAN membership.");
    const ranges = pieces(rule.ids, "VLAN IDs").map(entry => {
      const match = /^(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?$/.exec(entry);
      const low = Number(match?.[1]);
      const high = Number(match?.[2] ?? low);
      if (!match || low < 1 || high > 4094 || low > high) {
        throw new Error("Use VLAN IDs from 1 to 4094 or ranges such as 50-70.");
      }
      return [low, high];
    });
    const matches = vid => !ranges.length || ranges.some(([low, high]) => low <= vid && vid <= high);
    return port => {
      if (!port) return false;
      const nativeId = port.untaggedVlan?.vid;
      const untagged = rule.membership !== "tagged" && nativeId != null && matches(nativeId);
      const taggedAll = port.vlanMode === "tagged-all" &&
        (!ranges.length || ranges.some(([low, high]) => low !== high || low !== nativeId));
      const tagged = rule.membership !== "untagged" && (taggedAll || port.taggedVlans?.some(vlan => matches(vlan.vid)));
      return Boolean(untagged || tagged);
    };
  }

  function lengthPredicate({min, max}) {
    const valid = value => value === null || (Number.isFinite(value) && value >= 0 && value <= MAX_LENGTH);
    if (!valid(min) || !valid(max) || (min === null && max === null) || (min !== null && max !== null && min > max)) {
      throw new Error("Enter a minimum or maximum cable length in meters, with the lower value first.");
    }
    return cable => {
      if (cable.lengthValue == null || cable.lengthValue === "") return false;
      const meters = Number(cable.lengthValue) * LENGTH_METERS.get(cable.lengthUnit);
      if (!Number.isFinite(meters)) return false;
      const tolerance = Math.abs(meters) * Number.EPSILON * 2;
      return (min === null || meters + tolerance >= min) && (max === null || meters - tolerance <= max);
    };
  }

  function locationPredicate({scope, values}, rackId, siteId) {
    if (!LOCATIONS.some(([value]) => value === scope)) throw new Error("Choose a cable location.");
    const selected = idSet(values);
    if (scope.startsWith("selected-") && !selected.size) throw new Error("Choose at least one rack or site.");
    const isLocal = port => port?.device?.filter?.rack?.id === rackId && rackId != null;
    return (_cable, a, b) => {
      const aHere = isLocal(a);
      const bHere = isLocal(b);
      if (scope === "within-rack") return aHere && bHere;
      if (aHere === bHere) return false;
      const peer = (aHere ? b : a)?.device?.filter;
      if (!peer?.outsideRack) return false;
      switch (scope) {
        case "outside-rack": return true;
        case "other-rack": return peer.rack?.id != null;
        case "other-site": return siteId != null && peer.site?.id != null && peer.site.id !== siteId;
        case "selected-racks": return selected.has(peer.rack?.id);
        case "selected-sites": return selected.has(peer.site?.id);
        default: return false;
      }
    };
  }

  function tracePredicate(rule, current, portOnly) {
    const {scope, criteria} = rule;
    let stops = scope;
    let matches;
    if (scope === "any" || scope === "next") {
      matches = endpointCriteria(criteria);
      if (!matches) throw new Error("Choose an inventory attribute or port range for the trace condition.");
    } else {
      const geography = TRACE_GEOGRAPHY.find(([value]) => value === scope);
      if (!geography) throw new Error("Choose which part of the cable trace to match.");
      const [, , field, catalog] = geography;
      const selected = idSet(rule.values);
      if (catalog && !selected.size) throw new Error("Choose at least one destination.");
      const currentId = current[field];
      const outside = scope.startsWith("end-outside-");
      stops = scope.startsWith("end-") ? "ends" : "along";
      matches = port => {
        const place = port?.device?.filter?.tracePlace;
        if (!place || !Object.hasOwn(place, field)) return false;
        if (catalog) return selected.has(place[field]);
        return currentId != null && (outside ? place[field] !== currentId : place[field] === currentId);
      };
    }
    return (cable, port) => {
      const trace = (portOnly ? port : cable)?.filterTrace;
      return trace?.[stops]?.some(matches) ?? false;
    };
  }

  function prepare(tree, {vlan = true, rackId, locationId, siteId, portOnly = false} = {}) {
    let count = 0;
    const match = (scope, predicate) => portOnly ? (_cable, port) => predicate(port) : matchEndpoints(scope, predicate);
    function visit(rule, depth) {
      if (++count > MAX_NODES || depth > MAX_DEPTH) throw new Error("The filter has too many conditions or nested groups.");
      if (rule && Object.hasOwn(rule, "negated") && typeof rule.negated !== "boolean") {
        throw new Error("Invalid filter negation.");
      }
      if (portOnly && rule?.kind !== "group" && !PORT_RULES.has(rule?.kind)) {
        throw new Error("Choose a valid port filter condition.");
      }
      // A disabled condition remains unavailable even if a saved rule negates it.
      if (!vlan && (rule?.kind === "vlan" || rule?.kind === "vlan-mode")) return () => false;
      const predicate = visitRule(rule, depth);
      return predicate && rule.negated ? (...args) => !predicate(...args) : predicate;
    }

    function visitRule(rule, depth) {
      switch (rule?.kind) {
        case "group": {
          if (!Array.isArray(rule.children) || !["and", "or"].includes(rule.operator)) throw new Error("Invalid filter group.");
          const predicates = rule.children.map(child => visit(child, depth + 1)).filter(Boolean);
          if (!predicates.length) return null;
          return rule.operator === "and"
            ? (...args) => predicates.every(matches => matches(...args))
            : (...args) => predicates.some(matches => matches(...args));
        }
        case "endpoint": {
          const predicate = endpointCriteria(rule.criteria);
          if (!predicate) throw new Error("Choose an inventory attribute or port range for the condition.");
          return match(rule.endpoint, predicate);
        }
        case "between": {
          const left = endpointCriteria(rule.a);
          const right = endpointCriteria(rule.b);
          if (!left && !right) throw new Error("Choose an inventory attribute or port range on at least one side.");
          if (typeof rule.directional !== "boolean") throw new Error("Choose whether the endpoint order matters.");
          const first = left || Boolean;
          const second = right || Boolean;
          return (_cable, a, b) => (first(a) && second(b)) || (!rule.directional && first(b) && second(a));
        }
        case "trace": return tracePredicate(rule, {rackId, locationId, siteId}, portOnly);
        case "cable-type": {
          if (!Array.isArray(rule.values) || !rule.values.length || rule.values.length > MAX_VALUES ||
              rule.values.some(value => typeof value !== "string" || !value || value.length > 100)) {
            throw new Error("Choose at least one cable type.");
          }
          const values = new Set(rule.values);
          return cable => values.has(cable.typeValue);
        }
        case "length": return lengthPredicate(rule);
        case "location": return locationPredicate(rule, rackId, siteId);
        case "vlan": return match(rule.endpoint, vlanPredicate(rule));
        case "vlan-mode": {
          if (!Array.isArray(rule.values) || !rule.values.length ||
              rule.values.some(mode => !VLAN_MODES.some(([value]) => value === mode))) {
            throw new Error("Choose at least one VLAN mode.");
          }
          const modes = new Set(rule.values);
          return match(rule.endpoint, port => port?.kind === "interface" && modes.has(port.vlanMode ?? ""));
        }
        default: throw new Error("Invalid connection filter condition.");
      }
    }
    if (tree?.kind !== "group") throw new Error("Invalid connection filter.");
    return visit(tree, 0) ?? (() => true);
  }

  function compile(tree, features) {
    if (tree == null) return () => true;
    try {
      return prepare(tree, features);
    } catch {
      return () => false;
    }
  }

  function compilePort(tree, features) {
    const matches = compile(tree, {...features, portOnly: true});
    return port => matches(null, port);
  }

  function endpointPort(endpoint) {
    return {
      ...endpoint, id: endpoint.portId, name: endpoint.portName, url: endpoint.portUrl,
      device: {
        name: endpoint.deviceName, deviceType: endpoint.deviceType,
        deviceTypeId: endpoint.deviceTypeId, filterDeviceId: endpoint.filterDeviceId,
        rackName: endpoint.rackName, url: endpoint.deviceUrl,
        filter: endpoint.deviceFilter,
      },
    };
  }

  function element(tag, className = "", text = "") {
    const item = document.createElement(tag);
    item.className = className;
    item.textContent = text;
    return item;
  }

  function button(text, className = "btn-outline-secondary") {
    const item = element("button", "btn btn-sm " + className, text);
    item.type = "button";
    return item;
  }

  let fieldId = 0;

  function field(text, control) {
    const item = element("div", "re-connection-filter-field");
    const label = element("label", "form-label mb-0", text);
    control.id = "re-connection-filter-field-" + ++fieldId;
    label.htmlFor = control.id;
    item.append(label, control);
    return item;
  }

  function select(values, value, onChange) {
    const item = element("select", "form-select form-select-sm no-ts");
    for (const [optionValue, label] of values) item.add(new Option(label, optionValue));
    item.value = value;
    item.addEventListener("change", () => onChange(item.value));
    return item;
  }

  function input(value, type, placeholder, onInput) {
    const item = element("input", "form-control form-control-sm");
    item.type = type;
    item.value = value ?? "";
    item.placeholder = placeholder;
    if (type === "number") {
      item.min = "0";
      item.max = String(MAX_LENGTH);
      item.step = "any";
    } else {
      item.maxLength = MAX_TEXT;
    }
    item.addEventListener("input", () => onInput(item));
    return item;
  }

  function negation(target, label) {
    const control = element("label", "form-check re-connection-filter-negation");
    const checkbox = element("input", "form-check-input");
    checkbox.type = "checkbox";
    checkbox.checked = target.negated === true;
    checkbox.setAttribute("aria-label", label);
    checkbox.addEventListener("change", () => { target.negated = checkbox.checked; });
    control.append(checkbox, element("span", "form-check-label", "NOT"));
    return control;
  }

  const destinationPageSize = 40;

  function destinationLookup(path, excludedId) {
    const url = globalThis.NbCableEditorHttpUrl?.(path);
    if (!url) return null;
    return async ({query, ids}, signal) => {
      const request = new URL(url);
      request.searchParams.set("fields", "id,name");
      request.searchParams.set("limit", String(destinationPageSize));
      if (query) request.searchParams.set("q", query);
      for (const id of ids ?? []) request.searchParams.append("id", id);
      const response = await fetch(request, {headers: {Accept: "application/json"}, signal});
      if (!response.ok) throw new Error("Could not load destinations.");
      const {results, next} = await response.json();
      return {
        choices: results.filter(({id}) => id !== excludedId).map(({id, name}) => [id, `${name} (#${id})`]),
        hasMore: Boolean(next),
      };
    };
  }

  function multiSelect(label, values, choices, lookup, signal) {
    const details = element("details", "re-connection-filter-multi");
    const summary = element("summary", "btn btn-sm btn-outline-secondary");
    const list = element("div", "re-connection-filter-choices");
    const available = new Map(choices);
    const known = new Map();
    let results = [];
    let lookupStatus = "";
    let timer;
    let request;
    const updateSummary = () => { summary.textContent = values.length ? `${label} (${values.length})` : label; };
    const updateCheckbox = (checkbox, value, name) => {
      if (checkbox.checked) {
        if (values.length < MAX_VALUES) {
          values.push(value);
          if (lookup && !available.has(value)) known.set(value, name);
        } else checkbox.checked = false;
      } else {
        values.splice(values.indexOf(value), 1);
        known.delete(value);
      }
      updateSummary();
    };
    const search = input("", "search", "Search " + label.toLowerCase(), refresh);
    search.setAttribute("aria-label", "Search " + label.toLowerCase());
    search.addEventListener("keydown", event => {
      if (event.key === "Enter") event.preventDefault();
    });
    const clear = button("Clear selection");
    clear.addEventListener("click", () => {
      values.length = 0;
      known.clear();
      updateSummary();
      render();
    });

    function render() {
      const query = search.value.trim().toLowerCase();
      const matchingName = ([, name]) => name.toLowerCase().includes(query);
      const currentResults = new Map(results);
      const selected = new Set(values);
      const selectedChoices = values.map(value => [
        value, available.get(value) ?? known.get(value) ?? currentResults.get(value) ?? `Unavailable selection (#${value})`,
      ]).filter(matchingName);
      const matches = [...new Map([...results, ...choices.filter(matchingName)])]
        .filter(([value]) => !selected.has(value));
      const limit = 150;
      const shown = query
        ? [...matches.slice(0, limit), ...selectedChoices]
        : [...selectedChoices, ...matches.slice(0, limit)];
      const rows = shown.map(([value, name]) => {
        const row = element("label", "form-check mb-1");
        const checkbox = element("input", "form-check-input");
        checkbox.type = "checkbox";
        checkbox.checked = values.includes(value);
        checkbox.addEventListener("change", () => updateCheckbox(checkbox, value, name));
        row.append(checkbox, element("span", "form-check-label", name));
        return row;
      });
      if (!rows.length && !lookupStatus) rows.push(element("p", "text-secondary small mb-0", "No matching options."));
      if (matches.length > limit) rows.push(element("p", "text-secondary small mb-0",
        `Showing ${limit} of ${matches.length} unselected options. Search to narrow the list.`));
      if (lookupStatus) {
        const status = element("p", "text-secondary small mb-0", lookupStatus);
        status.setAttribute("role", "status");
        rows.push(status);
      }
      list.replaceChildren(...rows);
    }

    function stopLookup() {
      clearTimeout(timer);
      request?.abort();
    }

    async function restoreChoiceNames(ids, signal) {
      for (let start = 0; start < ids.length; start += destinationPageSize) {
        const {choices} = await lookup({ids: ids.slice(start, start + destinationPageSize)}, signal);
        if (signal.aborted) return;
        for (const [value, name] of choices) {
          if (values.includes(value)) known.set(value, name);
        }
      }
    }

    function refresh() {
      stopLookup();
      results = [];
      lookupStatus = lookup ? "Searching…" : "";
      render();
      if (!lookup) return;
      timer = setTimeout(async () => {
        if (!details.open || !details.isConnected || signal?.aborted) return;
        const pending = new AbortController();
        request = pending;
        const abort = () => pending.abort();
        signal?.addEventListener("abort", abort, {once: true});
        const ids = values.filter(value => !available.has(value) && !known.has(value));
        try {
          const [found] = await Promise.all([
            lookup({query: search.value.trim()}, pending.signal),
            restoreChoiceNames(ids, pending.signal),
          ]);
          if (pending.signal.aborted) return;
          results = found.choices;
          lookupStatus = found.hasMore ? "More options are available. Search to narrow the list." : "";
        } catch {
          if (pending.signal.aborted) return;
          pending.abort();
          lookupStatus = "Could not load options.";
        } finally {
          signal?.removeEventListener("abort", abort);
        }
        render();
      }, 180);
    }

    details.addEventListener("toggle", () => { if (details.open) refresh(); else stopLookup(); });
    details.append(summary, search, list, clear);
    updateSummary();
    return details;
  }

  function catalog({cables = [], cableTypes = [], devices = [], ports = [], endpoint}, {portOnly}) {
    const choices = Object.fromEntries(CRITERIA_FIELDS.map(([key]) => [key, new Map()]));
    const racks = new Map();
    const locations = new Map();
    const sites = new Map();
    function include(device) {
      if (!device) return;
      for (const [key] of DEVICE_FIELDS) {
        for (const {id, name} of deviceChoices(device, key)) {
          const label = key === "devices" && device.rackName ? name + " · " + device.rackName : name;
          choices[key].set(id, label);
        }
      }
      const {rack, location, site} = device.filter ?? {};
      if (rack) racks.set(rack.id, site ? rack.name + " · " + site.name : rack.name);
      if (location) locations.set(location.id, site ? location.name + " · " + site.name : location.name);
      if (site) sites.set(site.id, site.name);
    }
    function includePort(port) {
      if (!port) return;
      include(port.device);
      for (const [key] of PORT_FIELDS) {
        for (const {id, name} of portChoices(port, key)) choices[key].set(id, name);
      }
    }
    for (const device of devices) include(device);
    for (const port of ports) {
      includePort(port);
      if (portOnly) port.filterTrace?.any?.forEach(includePort);
    }
    if (!portOnly) {
      for (const cable of cables) {
        includePort(endpoint(cable, "A"));
        includePort(endpoint(cable, "B"));
        cable.filterTrace?.any?.forEach(includePort);
      }
    }
    function sorted(choices) {
      const names = new Map();
      for (const label of choices.values()) names.set(label, (names.get(label) ?? 0) + 1);
      return [...choices]
        .map(([id, label]) => [id, names.get(label) > 1 ? `${label} (#${id})` : label])
        .sort(([, a], [, b]) => a.localeCompare(b, undefined, {numeric: true}));
    }
    return {
      ...Object.fromEntries(Object.entries(choices).map(([key, options]) => [key, sorted(options)])),
      racks: sorted(racks),
      locations: sorted(locations),
      sites: sorted(sites),
      cableTypes: cableTypes.map(({value, label}) => [value, label]),
    };
  }

  function renderCriteria(title, criteria, choices, lookups, signal) {
    const item = element("fieldset", "re-connection-filter-criteria");
    if (title) item.append(element("legend", "form-label mb-0", title));
    const fields = element("div", "re-connection-filter-fields");
    for (const [key, label] of CRITERIA_FIELDS) {
      fields.append(multiSelect(label, criteria[key] ??= [], choices[key], lookups[key], signal));
    }
    const ports = input(criteria.portRanges, "text", "e.g. 1/1/1-1/1/24, mgmt", control => { criteria.portRanges = control.value; });
    item.append(fields, field("Port names or ranges", ports));
    return item;
  }

  function renderFields(container, rule, {choices, portOnly, destinations, excludedRackId, lookups, signal}) {
    const addEndpoint = () => {
      if (!portOnly) container.append(field("Match at", select(ENDPOINTS, rule.endpoint, value => { rule.endpoint = value; })));
    };
    const portHelp = () => element("p", "text-secondary small mb-0",
      "Separate names and ranges with commas. A range such as 1-24 matches trailing port numbers. Prefix a name with = for an exact match.");
    const criteria = (title, value) => renderCriteria(title, value, choices, lookups, signal);
    switch (rule.kind) {
      case "endpoint":
        addEndpoint();
        container.append(criteria("", rule.criteria), portHelp());
        break;
      case "between": {
        const sides = element("div", "re-connection-filter-sides");
        sides.append(criteria("First endpoint", rule.a), criteria("Second endpoint", rule.b));
        const direction = element("label", "form-check mb-0");
        const checkbox = element("input", "form-check-input");
        checkbox.type = "checkbox";
        checkbox.checked = rule.directional;
        checkbox.addEventListener("change", () => { rule.directional = checkbox.checked; });
        direction.append(checkbox, element("span", "form-check-label", "Match first endpoint to cable end A and second to end B"));
        container.append(sides, portHelp(), direction);
        break;
      }
      case "trace": {
        const fields = element("div", "re-connection-filter-rule-fields");
        const renderScope = () => {
          if (Object.hasOwn(TRACE_GEOGRAPHY_SCOPES, rule.scope)) {
            const key = TRACE_GEOGRAPHY_SCOPES[rule.scope];
            const description = rule.scope.startsWith("end-")
              ? "Checks the destinations at the ends of the traced path."
              : "Checks the places visited by devices on the traced path, including its ends.";
            fields.replaceChildren(element("p", "text-secondary small mb-0", description));
            if (key) {
              const label = {racks: "Racks", locations: "Locations", sites: "Sites"}[key];
              fields.append(multiSelect(label, rule.values ??= [], choices[key], destinations.trace[key], signal));
            }
          } else {
            const help = element("p", "text-secondary small mb-0",
              "Next device matches the nearest other device in each trace direction, including through mapped patch panel ports.");
            fields.replaceChildren(help, criteria("", rule.criteria ??= emptyCriteria()), portHelp());
          }
        };
        const scope = select(TRACE_SCOPES, rule.scope, value => {
          if (Object.hasOwn(TRACE_GEOGRAPHY_SCOPES, value)) {
            if (TRACE_GEOGRAPHY_SCOPES[rule.scope] !== TRACE_GEOGRAPHY_SCOPES[value]) rule.values = [];
            delete rule.criteria;
          } else {
            delete rule.values;
          }
          rule.scope = value;
          renderScope();
        });
        const groups = ["Trace devices", "Trace ends", "Along the trace"].map(label => {
          const group = element("optgroup");
          group.label = label;
          return group;
        });
        for (const option of [...scope.options]) {
          const index = option.value.startsWith("end-") ? 1 : option.value.startsWith("along-") ? 2 : 0;
          groups[index].append(option);
        }
        scope.append(...groups);
        scope.value = rule.scope;
        container.append(field("Search trace for", scope), fields);
        renderScope();
        break;
      }
      case "vlan": {
        addEndpoint();
        container.append(field("Membership", select(MEMBERSHIPS, rule.membership, value => { rule.membership = value; })));
        const ids = input(rule.ids, "text", "e.g. 10, 50-70", control => { rule.ids = control.value.trim().replaceAll("–", "-"); });
        container.append(field("VLAN IDs or ranges (optional)", ids));
        break;
      }
      case "vlan-mode":
        addEndpoint();
        container.append(multiSelect("VLAN modes", rule.values, VLAN_MODES));
        break;
      case "location": {
        const targets = element("div");
        const renderTargets = () => {
          const key = {"selected-racks": "racks", "selected-sites": "sites"}[rule.scope];
          const options = key === "racks" ? choices.racks.filter(([id]) => id !== excludedRackId) : choices[key];
          targets.replaceChildren(...(key
            ? [multiSelect(key === "racks" ? "Racks" : "Sites", rule.values, options, destinations[key], signal)]
            : []));
        };
        const scope = select(LOCATIONS, rule.scope, value => {
          rule.scope = value;
          rule.values = [];
          renderTargets();
        });
        container.append(field("Location", scope), targets);
        renderTargets();
        break;
      }
      case "cable-type":
        container.append(multiSelect("Cable types", rule.values, choices.cableTypes));
        break;
      case "length": {
        const bound = key => input(rule[key], "number", "Any", control => {
          rule[key] = control.validity.badInput ? NaN : control.value === "" ? null : control.valueAsNumber;
        });
        const bounds = element("div", "re-connection-filter-fields");
        bounds.append(field("Minimum (m)", bound("min")), field("Maximum (m)", bound("max")));
        container.append(bounds);
        break;
      }
    }
  }

  function treeSize(tree) {
    return tree.kind === "group" ? 1 + tree.children.reduce((sum, child) => sum + treeSize(child), 0) : 1;
  }

  function createDialog({
    dialog, getCatalog, getFilter, onApply, onPreview, onPreviewEnd, vlan = true, rackId, locationId, siteId,
    destinationUrls = {}, lookups = {}, excludeCurrentRack = true, portOnly = false, getAction = () => "block",
    conditionOnly = false, title, subjectLabel, onCancel,
  }) {
    const form = element("form", "re-rack-dialog-body");
    form.noValidate = true;
    const heading = element("h2", "re-rack-dialog-title", title ?? (portOnly ? "Filter ports" : "Filter connections"));
    heading.id = title ? dialog.id + "-title" : portOnly ? "re-port-filter-title" : "re-connection-filter-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const help = element("p", "re-rack-dialog-summary", "All items match without conditions. Combine conditions in AND and OR groups. Use NOT to invert a condition or group. For an endpoint or trace stop, all chosen fields must match, with any selected item per field.");
    const container = element("div", "re-connection-filter-tree");
    const error = element("p", "alert alert-danger mb-0");
    error.hidden = true;
    error.setAttribute("role", "alert");
    error.tabIndex = -1;
    const actions = element("div", "re-rack-dialog-actions");
    const cancel = button("Cancel");
    const preview = button("Preview in rack");
    const apply = button(conditionOnly ? "Apply conditions" : "Apply filter", "btn-primary");
    apply.type = "submit";
    actions.append(cancel);
    if (onPreview) actions.append(preview);
    actions.append(apply);
    const portActions = [["block", "Block editing"], ["hide", "Hide port"], ["mark", "Mark with a red X"]];
    const actionControl = select(portActions, "block", () => {});
    form.append(heading, help);
    if (portOnly && !conditionOnly) form.append(field("Ports that do not match", actionControl));
    form.append(container, error, actions);
    dialog.append(form);
    let draft;
    let choices;
    let lookupController;
    let previewing = false;
    const availableRules = RULE_TYPES.filter(([kind]) => (!portOnly || PORT_RULES.has(kind)) &&
      (vlan || !kind.startsWith("vlan")));
    const evaluation = {vlan, rackId, locationId, siteId, portOnly};
    const excludedRackId = excludeCurrentRack ? rackId : undefined;
    const sites = destinationLookup(destinationUrls.sites);
    const destinations = {
      racks: destinationLookup(destinationUrls.racks, excludedRackId),
      sites,
      trace: {
        racks: destinationLookup(destinationUrls.racks),
        locations: destinationLookup(destinationUrls.locations),
        sites,
      },
    };

    function showError(message = "") {
      error.textContent = message;
      error.hidden = !message;
      if (message) error.focus();
    }

    function renderGroup(group, depth, onRemove) {
      const card = element("div", "re-connection-filter-group");
      const header = element("div", "re-connection-filter-header");
      const operators = [["and", "All conditions (AND)"], ["or", "Any condition (OR)"]];
      const operator = select(operators, group.operator, value => { group.operator = value; });
      header.append(field(depth ? "Nested group" : "Match " + (subjectLabel ?? (portOnly ? "ports" : "connections")) + " using", operator),
        negation(group, "Negate group"));
      if (onRemove) {
        const remove = button("Remove group");
        remove.addEventListener("click", onRemove);
        header.append(remove);
      }
      const children = element("div", "re-connection-filter-children");
      const emptyGroup = element("p", "text-secondary small mb-0", "No conditions in this group.");
      emptyGroup.hidden = group.children.length > 0;
      const controls = element("div", "re-connection-filter-controls");
      const addRule = button("Add condition");
      const addGroup = button("Add group");
      addRule.disabled = depth >= MAX_DEPTH;
      addGroup.disabled = depth >= MAX_DEPTH - 1;
      controls.append(addRule, addGroup);

      function append(child) {
        function remove() {
          group.children.splice(group.children.indexOf(child), 1);
          row.remove();
          emptyGroup.hidden = group.children.length > 0;
          addRule.focus();
          showError();
        }
        const row = child.kind === "group" ? renderGroup(child, depth + 1, remove) : renderRule(child, remove);
        children.append(row);
        return row;
      }

      function add(child) {
        if (treeSize(draft) >= MAX_NODES) {
          showError("The filter can contain up to " + MAX_NODES + " groups and conditions.");
          return;
        }
        group.children.push(child);
        emptyGroup.hidden = true;
        append(child).querySelector("select").focus();
        showError();
      }

      for (const child of group.children) append(child);
      addRule.addEventListener("click", () => add(newRule("endpoint")));
      addGroup.addEventListener("click", () => add(empty()));
      card.append(header, children, emptyGroup, controls);
      return card;
    }

    function renderRule(rule, onRemove) {
      const row = element("div", "re-connection-filter-rule");
      const header = element("div", "re-connection-filter-header");
      const fields = element("div", "re-connection-filter-rule-fields");
      const fieldContext = {choices, portOnly, destinations, excludedRackId, lookups, signal: lookupController.signal};
      const disabledVlanRule = rule.kind.startsWith("vlan") && !vlan;
      const disabledLabel = RULE_TYPES.find(([kind]) => kind === rule.kind)?.[1];
      const ruleTypes = disabledVlanRule
        ? [...availableRules, [rule.kind, disabledLabel + " (disabled)"]] : availableRules;
      const type = select(ruleTypes, rule.kind, kind => {
        const {negated} = rule;
        for (const key of Object.keys(rule)) delete rule[key];
        Object.assign(rule, newRule(kind));
        if (negated) rule.negated = true;
        fields.replaceChildren();
        renderFields(fields, rule, fieldContext);
        showError();
      });
      const remove = button("Remove condition");
      remove.addEventListener("click", onRemove);
      header.append(field("Condition", type), negation(rule, "Negate condition"), remove);
      if (disabledVlanRule) {
        type.selectedOptions[0].disabled = true;
        fields.append(element("p", "text-secondary small mb-0",
          "This condition cannot match while VLAN functions are disabled."));
      } else {
        renderFields(fields, rule, fieldContext);
      }
      row.append(header, fields);
      return row;
    }

    function validDraft() {
      try {
        prepare(draft, evaluation);
        return true;
      } catch (exception) {
        showError(exception.message);
        return false;
      }
    }

    function cancelPreview() {
      if (!previewing) return;
      previewing = false;
      onPreviewEnd?.();
    }

    function closeDraft(cancelled = false) {
      lookupController?.abort();
      dialog.close();
      if (cancelled) onCancel?.();
    }

    const lifecycle = new AbortController();
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      closeDraft(true);
    }, {signal: lifecycle.signal});
    cancel.addEventListener("click", () => closeDraft(true));
    preview.addEventListener("click", () => {
      if (!validDraft()) return;
      previewing = true;
      dialog.close();
      onPreview?.(structuredClone(draft), actionControl.value);
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!validDraft()) return;
      onApply(draft, actionControl.value);
      closeDraft();
    });

    return {
      open() {
        cancelPreview();
        lookupController?.abort();
        lookupController = new AbortController();
        choices = catalog(getCatalog(), evaluation);
        const filter = getFilter();
        try {
          prepare(filter, evaluation);
          draft = structuredClone(filter);
        } catch {
          draft = empty();
        }
        const action = getAction();
        actionControl.value = portActions.some(([value]) => value === action) ? action : "block";
        container.replaceChildren(renderGroup(draft, 0));
        showError();
        dialog.showModal();
      },
      resume() {
        if (!previewing) return;
        cancelPreview();
        dialog.showModal();
        preview.focus();
      },
      cancelPreview,
      destroy() {
        cancelPreview();
        lifecycle.abort();
        lookupController?.abort();
        if (dialog.open) dialog.close();
        form.remove();
        dialog.removeAttribute("aria-labelledby");
      },
    };
  }

  const createPortDialog = options => createDialog({...options, portOnly: true});
  globalThis.NbCableEditorConnectionFilter = {
    empty, compile, compilePort, endpointPort, createDialog, createPortDialog,
    criteriaFields: CRITERIA_FIELDS.map(([key]) => key),
  };
})();
