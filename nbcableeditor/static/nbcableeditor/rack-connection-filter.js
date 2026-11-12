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
  const RULE_TYPES = [
    ["endpoint", "Device, device type or ports"], ["between", "Between endpoints"],
    ["vlan", "VLAN membership"], ["cable-type", "Cable type"], ["length", "Cable length"],
  ];

  function empty() {
    return {kind: "group", operator: "and", children: []};
  }

  function emptyCriteria() {
    return {devices: [], deviceTypes: [], portRanges: ""};
  }

  function newRule(kind) {
    switch (kind) {
      case "endpoint": return {kind, endpoint: "any", criteria: emptyCriteria()};
      case "between": return {kind, a: emptyCriteria(), b: emptyCriteria(), directional: false};
      case "vlan": return {kind, endpoint: "any", membership: "any", ids: ""};
      case "cable-type": return {kind, values: []};
      case "length": return {kind, min: null, max: null};
    }
  }

  function idSet(values) {
    if (!Array.isArray(values) || values.length > MAX_VALUES ||
        values.some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error("A device or device type selection is invalid.");
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

  function endpointCriteria(criteria) {
    const devices = idSet(criteria?.devices);
    const types = idSet(criteria?.deviceTypes);
    const ports = portSelectors(criteria?.portRanges);
    if (!devices.size && !types.size && !ports.length) return null;
    return port => Boolean(port &&
      (!devices.size || devices.has(port.device?.id ?? port.device?.filterDeviceId)) &&
      (!types.size || types.has(port.device?.deviceTypeId)) &&
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

  function prepare(tree, {vlan = true} = {}) {
    let count = 0;
    function visit(rule, depth) {
      if (++count > MAX_NODES || depth > MAX_DEPTH) throw new Error("The filter has too many conditions or nested groups.");
      switch (rule?.kind) {
        case "group": {
          if (!Array.isArray(rule.children) || !["and", "or"].includes(rule.operator)) throw new Error("Invalid filter group.");
          if (depth && !rule.children.length) throw new Error("Add a condition to each nested group or remove the empty group.");
          if (!rule.children.length) return () => false;
          const predicates = rule.children.map(child => visit(child, depth + 1));
          return rule.operator === "and"
            ? (...args) => predicates.every(matches => matches(...args))
            : (...args) => predicates.some(matches => matches(...args));
        }
        case "endpoint": {
          const predicate = endpointCriteria(rule.criteria);
          if (!predicate) throw new Error("Choose a device, device type or port for each endpoint condition.");
          return matchEndpoints(rule.endpoint, predicate);
        }
        case "between": {
          const left = endpointCriteria(rule.a);
          const right = endpointCriteria(rule.b);
          if (!left && !right) throw new Error("Choose a device, device type or port on at least one side of a between condition.");
          if (typeof rule.directional !== "boolean") throw new Error("Choose whether the endpoint order matters.");
          const first = left || Boolean;
          const second = right || Boolean;
          return (_cable, a, b) => (first(a) && second(b)) || (!rule.directional && first(b) && second(a));
        }
        case "cable-type": {
          if (!Array.isArray(rule.values) || !rule.values.length || rule.values.length > MAX_VALUES ||
              rule.values.some(value => typeof value !== "string" || !value || value.length > 100)) {
            throw new Error("Choose at least one cable type.");
          }
          const values = new Set(rule.values);
          return cable => values.has(cable.typeValue);
        }
        case "length": return lengthPredicate(rule);
        case "vlan": return vlan ? matchEndpoints(rule.endpoint, vlanPredicate(rule)) : () => false;
        default: throw new Error("Invalid connection filter condition.");
      }
    }
    if (tree?.kind !== "group") throw new Error("Invalid connection filter.");
    return visit(tree, 0);
  }

  function compile(tree, features) {
    try {
      return prepare(tree, features);
    } catch {
      return () => false;
    }
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

  function multiSelect(label, values, choices) {
    const details = element("details", "re-connection-filter-multi");
    const summary = element("summary", "btn btn-sm btn-outline-secondary");
    const list = element("div", "re-connection-filter-choices");
    const rows = [];
    const visibleValues = new Set(choices.map(([value]) => value));
    const updateSummary = () => { summary.textContent = values.length ? `${label} (${values.length})` : label; };
    const updateCheckbox = (checkbox, value) => {
      if (checkbox.checked) {
        if (values.length < MAX_VALUES) values.push(value);
        else checkbox.checked = false;
      } else {
        values.splice(values.indexOf(value), 1);
      }
      updateSummary();
    };
    const noChoices = element("p", "text-secondary small mb-0", "No matching options.");
    const search = input("", "search", "Search " + label.toLowerCase(), control => {
      const query = control.value.trim().toLowerCase();
      for (const {row, name} of rows) row.hidden = !name.includes(query);
      noChoices.hidden = rows.some(({row}) => !row.hidden);
    });
    search.setAttribute("aria-label", "Search " + label.toLowerCase());
    search.addEventListener("keydown", event => {
      if (event.key === "Enter") event.preventDefault();
    });
    const clear = button("Clear selection");
    clear.addEventListener("click", () => {
      values.length = 0;
      for (const {checkbox} of rows) checkbox.checked = false;
      unavailable.hidden = true;
      updateSummary();
    });
    for (const [value, name] of choices) {
      const row = element("label", "form-check mb-1");
      const checkbox = element("input", "form-check-input");
      checkbox.type = "checkbox";
      checkbox.checked = values.includes(value);
      checkbox.addEventListener("change", () => updateCheckbox(checkbox, value));
      row.append(checkbox, element("span", "form-check-label", name));
      list.append(row);
      rows.push({row, checkbox, name: name.toLowerCase()});
    }
    const unavailable = element("p", "text-secondary small mb-0", "The selection includes unavailable options.");
    unavailable.hidden = values.every(value => visibleValues.has(value));
    noChoices.hidden = choices.length > 0;
    list.append(noChoices, unavailable);
    details.append(summary, search, list, clear);
    updateSummary();
    return details;
  }

  function catalog({cables, cableTypes, devices, endpoint}) {
    const deviceChoices = new Map();
    const typeChoices = new Map();
    function include(device) {
      const id = device?.id ?? device?.filterDeviceId;
      if (id != null && !deviceChoices.has(id)) {
        const label = device.name + (device.rackName ? " · " + device.rackName : "");
        deviceChoices.set(id, label);
      }
      if (device?.deviceTypeId != null && device.deviceType) typeChoices.set(device.deviceTypeId, device.deviceType);
    }
    for (const device of devices) include(device);
    for (const cable of cables) {
      include(endpoint(cable, "A")?.device);
      include(endpoint(cable, "B")?.device);
    }
    function sorted(choices) {
      const names = new Map();
      for (const label of choices.values()) names.set(label, (names.get(label) ?? 0) + 1);
      return [...choices]
        .map(([id, label]) => [id, names.get(label) > 1 ? `${label} (#${id})` : label])
        .sort(([, a], [, b]) => a.localeCompare(b, undefined, {numeric: true}));
    }
    return {
      devices: sorted(deviceChoices), deviceTypes: sorted(typeChoices),
      cableTypes: cableTypes.map(({value, label}) => [value, label]),
    };
  }

  function renderCriteria(title, criteria, choices) {
    const item = element("fieldset", "re-connection-filter-criteria");
    if (title) item.append(element("legend", "form-label mb-0", title));
    const fields = element("div", "re-connection-filter-fields");
    fields.append(
      multiSelect("Devices", criteria.devices, choices.devices),
      multiSelect("Device types", criteria.deviceTypes, choices.deviceTypes),
    );
    const ports = input(criteria.portRanges, "text", "e.g. 1/1/1-1/1/24, mgmt", control => { criteria.portRanges = control.value; });
    item.append(fields, field("Port names or ranges", ports));
    return item;
  }

  function renderFields(container, rule, choices) {
    const addEndpoint = () => container.append(field("Match at", select(ENDPOINTS, rule.endpoint, value => { rule.endpoint = value; })));
    const portHelp = () => element("p", "text-secondary small mb-0",
      "Separate names and ranges with commas. A range such as 1-24 matches trailing port numbers. Prefix a name with = for an exact match.");
    switch (rule.kind) {
      case "endpoint":
        addEndpoint();
        container.append(renderCriteria("", rule.criteria, choices), portHelp());
        break;
      case "between": {
        const sides = element("div", "re-connection-filter-sides");
        sides.append(renderCriteria("First endpoint", rule.a, choices), renderCriteria("Second endpoint", rule.b, choices));
        const direction = element("label", "form-check mb-0");
        const checkbox = element("input", "form-check-input");
        checkbox.type = "checkbox";
        checkbox.checked = rule.directional;
        checkbox.addEventListener("change", () => { rule.directional = checkbox.checked; });
        direction.append(checkbox, element("span", "form-check-label", "Match first endpoint to cable end A and second to end B"));
        container.append(sides, portHelp(), direction);
        break;
      }
      case "vlan": {
        addEndpoint();
        container.append(field("Membership", select(MEMBERSHIPS, rule.membership, value => { rule.membership = value; })));
        const ids = input(rule.ids, "text", "e.g. 10, 50-70", control => { rule.ids = control.value.trim().replaceAll("–", "-"); });
        container.append(field("VLAN IDs or ranges (optional)", ids));
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

  function createDialog({dialog, getCatalog, getFilter, onApply, vlan = true}) {
    const form = element("form", "re-rack-dialog-body");
    form.noValidate = true;
    const heading = element("h2", "re-rack-dialog-title", "Filter connections");
    heading.id = "re-connection-filter-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const help = element("p", "re-rack-dialog-summary", "Combine conditions in AND and OR groups. In each endpoint, all chosen fields must match, and any one selected item in each field can match.");
    const container = element("div", "re-connection-filter-tree");
    const error = element("p", "alert alert-danger mb-0");
    error.hidden = true;
    error.setAttribute("role", "alert");
    error.tabIndex = -1;
    const actions = element("div", "re-rack-dialog-actions");
    const cancel = button("Cancel");
    const apply = button("Apply filter", "btn-primary");
    apply.type = "submit";
    actions.append(cancel, apply);
    form.append(heading, help, container, error, actions);
    dialog.append(form);
    let draft;
    let choices;
    const availableRules = vlan ? RULE_TYPES : RULE_TYPES.filter(([kind]) => kind !== "vlan");

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
      header.append(field(depth ? "Nested group" : "Match connections using", operator));
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
      const disabledVlanRule = rule.kind === "vlan" && !vlan;
      const ruleTypes = disabledVlanRule ? [...availableRules, ["vlan", "VLAN membership (disabled)"]] : availableRules;
      const type = select(ruleTypes, rule.kind, kind => {
        for (const key of Object.keys(rule)) delete rule[key];
        Object.assign(rule, newRule(kind));
        fields.replaceChildren();
        renderFields(fields, rule, choices);
        showError();
      });
      const remove = button("Remove condition");
      remove.addEventListener("click", onRemove);
      header.append(field("Condition", type), remove);
      if (disabledVlanRule) {
        type.selectedOptions[0].disabled = true;
        fields.append(element("p", "text-secondary small mb-0",
          "This condition cannot match while VLAN functions are disabled."));
      } else {
        renderFields(fields, rule, choices);
      }
      row.append(header, fields);
      return row;
    }

    cancel.addEventListener("click", () => dialog.close());
    form.addEventListener("submit", event => {
      event.preventDefault();
      try {
        prepare(draft, {vlan});
      } catch (exception) {
        showError(exception.message);
        return;
      }
      onApply(draft);
      dialog.close();
    });

    return {
      open() {
        choices = catalog(getCatalog());
        const filter = getFilter();
        try {
          prepare(filter, {vlan});
          draft = structuredClone(filter);
        } catch {
          draft = empty();
        }
        container.replaceChildren(renderGroup(draft, 0));
        showError();
        dialog.showModal();
      },
    };
  }

  globalThis.NbCableEditorConnectionFilter = {empty, compile, createDialog};
})();
