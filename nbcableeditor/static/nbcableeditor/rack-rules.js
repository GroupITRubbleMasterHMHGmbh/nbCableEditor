(() => {
  "use strict";

  const MAX_RULES = 100;
  const MAX_CONDITIONS = 100;
  const MAX_DEPTH = 8;
  const MAX_VALUES = 1000;
  const hexColor = value => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  const boolean = (key, label) => ({key, label, type: "boolean"});
  const color = (key, label) => ({key, label, type: "color"});
  const choice = (key, label, choices) => ({key, label, type: "choice", choices});
  const number = (key, label, min, max, step) => ({key, label, type: "number", min, max, step});
  const actionDefinitions = {
    interface: [
      boolean("visible", "Show port"), boolean("edit", "Allow edit"), color("color", "Port color"),
      choice("icon", "Interface icon", [["none", "None"], ["red-x", "Red X"],
        ["green-check", "Green checkbox"], ["circle", "Colored circle outside"],
        ["rectangle", "Colored rectangle outside"]]),
      color("iconColor", "Icon color"), boolean("hideLabel", "Hide port number"),
      choice("fontWeight", "Interface font weight", [["normal", "Normal"], ["bold", "Bold"],
        ...[100, 200, 300, 400, 500, 600, 700, 800, 900].map(weight => [String(weight), String(weight)])]),
      color("labelColor", "Interface label color"), boolean("connect", "Enable Connect To"),
      boolean("disconnect", "Enable Disconnect From"), boolean("hideCable", "Hide cable if connected"),
      boolean("virtualCable", "Show virtual cable if unconnected"),
    ],
    connection: [
      boolean("edit", "Allow edit"), boolean("virtualPipe", "Allow virtual pipe"),
      boolean("hover", "Enable hover"), boolean("details", "Enable details dialog"),
      color("color", "Cable color"), number("luminosity", "Luminosity (%)", 0, 200, 1),
      number("opacity", "Opacity", 0, 1, 0.05),
      choice("lineStyle", "Line style", [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]]),
      number("width", "Cable width", 0.5, 20, 0.5), boolean("visible", "Show cable"),
    ],
    device: [
      boolean("edit", "Allow edit"), boolean("grayBox", "Display as gray box"),
      boolean("interfaces", "Show interfaces"), boolean("cables", "Show cables"),
      boolean("front", "Show in front view"), boolean("rear", "Show in rear view"),
    ],
  };
  const criteriaFields = new Set([
    "devices", "deviceTypes", "deviceRoles", "deviceTags", "deviceTypeTags", "deviceManufacturers",
    "interfaces", "modules", "moduleTypes", "moduleTags", "moduleTypeTags", "moduleManufacturers",
  ]);
  const endpointScopes = new Set(["any", "both", "a", "b"]);
  const vlanModes = new Set(["", "access", "tagged", "tagged-all", "q-in-q"]);
  const selectedTraceScopes = new Set([
    "end-in-racks", "end-in-locations", "end-in-sites", "along-racks", "along-locations", "along-sites",
    "along-racks-in-locations",
  ]);
  const traceScopes = new Set([...selectedTraceScopes,
    "end-outside-rack", "end-outside-location", "end-outside-site",
    "end-in-current-rack", "end-in-current-location", "end-in-current-site",
    "along-current-rack", "along-current-location", "along-current-site",
  ]);
  const portConditionKinds = new Set(["endpoint", "trace", "vlan", "vlan-mode"]);

  function fail(message) {
    throw new Error(message);
  }

  function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("Enter valid " + label + ".");
    return value;
  }

  function fields(value, allowed, label, required = []) {
    object(value, label);
    if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
      fail("Enter valid " + label + ".");
    }
  }

  function ids(value) {
    return Array.isArray(value) && value.length <= MAX_VALUES &&
      value.every(id => Number.isSafeInteger(id) && id > 0);
  }

  function criteria(value) {
    object(value, "endpoint criteria");
    for (const [key, selection] of Object.entries(value)) {
      if (key === "portRanges") {
        if (typeof selection !== "string" || selection.length > 1024) fail("Enter valid port names and ranges.");
      } else if (!criteriaFields.has(key) || !ids(selection)) fail("Enter valid endpoint selections.");
    }
    return Object.values(value).some(selection => typeof selection === "string" ? selection.trim() : selection.length);
  }

  function textSelections(values, allowed) {
    return Array.isArray(values) && values.length > 0 && values.length <= MAX_VALUES &&
      values.every(value => typeof value === "string" && (allowed ? allowed.has(value) : value.length > 0 && value.length <= 100));
  }

  function validateCondition(tree, kind) {
    if (tree?.kind !== "group") fail("A rule needs a condition group.");
    let count = 0;
    function visit(condition, depth) {
      if (++count > MAX_CONDITIONS || depth > MAX_DEPTH) fail("Use up to 100 conditions and 8 nested levels per rule.");
      object(condition, "condition");
      const {kind: conditionKind, negated, ...values} = condition;
      if (negated !== undefined && typeof negated !== "boolean") fail("Choose whether to negate the condition.");
      if (kind !== "connection" && conditionKind !== "group" && !portConditionKinds.has(conditionKind)) {
        fail("Choose a valid interface or device condition.");
      }
      const required = names => fields(values, names, "condition", names);
      const endpoint = () => {
        if (!endpointScopes.has(values.endpoint)) fail("Choose which endpoints to match.");
      };
      switch (conditionKind) {
        case "group":
          required(["operator", "children"]);
          if (!["and", "or"].includes(values.operator) || !Array.isArray(values.children)) fail("Combine conditions with AND or OR.");
          for (const child of values.children) visit(child, depth + 1);
          break;
        case "endpoint":
          required(["endpoint", "criteria"]);
          endpoint();
          if (!criteria(values.criteria)) fail("Select an endpoint attribute or port range.");
          break;
        case "between": {
          required(["a", "b", "directional"]);
          const left = criteria(values.a);
          const right = criteria(values.b);
          if ((!left && !right) || typeof values.directional !== "boolean") {
            fail("Select endpoint attributes for the connection.");
          }
          break;
        }
        case "trace":
          if (["any", "next"].includes(values.scope)) {
            required(["scope", "criteria"]);
            if (!criteria(values.criteria)) fail("Select an attribute for the cable trace.");
          } else {
            required(["scope", "values"]);
            if (!traceScopes.has(values.scope) || !ids(values.values) ||
                (selectedTraceScopes.has(values.scope) && !values.values.length)) fail("Select a valid trace destination.");
          }
          break;
        case "vlan":
          required(["endpoint", "membership", "ids"]);
          endpoint();
          if (!["any", "tagged", "untagged"].includes(values.membership) ||
              typeof values.ids !== "string" || values.ids.length > 1024) fail("Select valid VLAN settings.");
          break;
        case "vlan-mode":
          required(["endpoint", "values"]);
          endpoint();
          if (!textSelections(values.values, vlanModes) || values.values.length > 5) fail("Select a VLAN mode.");
          break;
        case "location":
          required(["scope", "values"]);
          if (!["within-rack", "outside-rack", "other-rack", "other-site", "selected-racks", "selected-sites"].includes(values.scope) ||
              !ids(values.values) || (values.scope.startsWith("selected-") && !values.values.length)) fail("Select a cable location.");
          break;
        case "cable-type":
          required(["values"]);
          if (!textSelections(values.values)) fail("Select a cable type.");
          break;
        case "length":
          required(["min", "max"]);
          if (![values.min, values.max].every(value => value === null ||
                (Number.isFinite(value) && value >= 0 && value <= 1e12)) ||
              (values.min === null && values.max === null) ||
              (values.min !== null && values.max !== null && values.min > values.max)) fail("Enter a valid cable length range.");
          break;
        default: fail("Choose a valid condition.");
      }
    }
    visit(tree, 0);
    // The existing compiler also checks the syntax of VLAN and interface ranges.
    // Its public compile method fails closed, so validate range text explicitly here.
    validateRanges(tree);
  }

  function validateRanges(condition) {
    if (condition.kind === "group") {
      condition.children.forEach(validateRanges);
      return;
    }
    if (condition.kind === "vlan" && condition.ids.trim()) {
      for (const entry of condition.ids.split(",")) {
        const match = /^\s*(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?\s*$/.exec(entry);
        const low = Number(match?.[1]);
        const high = Number(match?.[2] ?? low);
        if (!match || low < 1 || high > 4094 || low > high) fail("Use VLAN IDs from 1 to 4094.");
      }
    }
    for (const selection of [condition.criteria, condition.a, condition.b]) {
      if (!selection?.portRanges?.trim()) continue;
      for (const entry of selection.portRanges.trim().split(/\s*,\s*/)) {
        if (!entry || entry === "=") fail("Enter valid port names and ranges.");
        if (entry.startsWith("=")) continue;
        const range = /^(.*?)(\d+)\s*[-–]\s*(.*?)(\d+)$/.exec(entry.toLowerCase());
        if (!range || (range[3] && range[1] !== range[3])) continue;
        if (!Number.isSafeInteger(Number(range[2])) || !Number.isSafeInteger(Number(range[4])) ||
            Number(range[2]) > Number(range[4])) fail("Enter port ranges from the lower number to the higher number.");
      }
    }
  }

  function validateActions(kind, actions) {
    object(actions, "rule actions");
    const definitions = actionDefinitions[kind];
    for (const [key, value] of Object.entries(actions)) {
      const definition = definitions.find(item => item.key === key);
      if (!definition) fail("Choose a valid rule action.");
      const {type, choices, min, max} = definition;
      const valid = type === "boolean" ? typeof value === "boolean"
        : type === "color" ? hexColor(value)
          : type === "choice" ? choices.some(([choice]) => choice === value)
            : Number.isFinite(value) && min <= value && value <= max;
      if (!valid) fail("Enter a valid value for " + definition.label.toLowerCase() + ".");
    }
  }

  function validate(kind, rules) {
    if (!Object.hasOwn(actionDefinitions, kind)) fail("Choose a valid rule type.");
    if (!Array.isArray(rules) || rules.length > MAX_RULES) fail("Use up to 100 ordered rules.");
    for (const rule of rules) {
      fields(rule, ["name", "enabled", "condition", "actions", "halt"], "rule", ["condition", "actions"]);
      if (rule.name !== undefined && (typeof rule.name !== "string" || rule.name.length > 200)) fail("Use a rule name up to 200 characters.");
      if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") fail("Choose whether the rule is enabled.");
      if (rule.halt !== undefined && typeof rule.halt !== "boolean") fail("Choose whether to halt after the rule.");
      validateCondition(rule.condition, kind);
      validateActions(kind, rule.actions);
    }
    return true;
  }

  function hasConditions(tree) {
    return tree?.kind === "group" ? tree.children?.some(hasConditions) : Boolean(tree);
  }

  function normalize(kind, rules, {legacyFilter, legacyAction} = {}) {
    if (!Object.hasOwn(actionDefinitions, kind)) fail("Choose a valid rule type.");
    if (rules !== undefined) {
      validate(kind, rules);
      return rules.map(rule => ({name: "", enabled: true, halt: false, ...structuredClone(rule)}));
    }
    if (kind === "device" || !hasConditions(legacyFilter)) return [];
    const condition = structuredClone(legacyFilter);
    condition.negated = !condition.negated;
    let actions = {visible: false};
    if (kind === "interface" && legacyAction !== "hide") {
      actions = legacyAction === "mark" ? {icon: "red-x"} : {edit: false, connect: false, disconnect: false};
    }
    const converted = [{name: "Imported filter", enabled: true, condition, actions, halt: false}];
    validate(kind, converted);
    return converted;
  }

  function deviceCondition(tree, features) {
    if (tree.kind === "group") {
      const children = tree.children.filter(hasConditions).map(child => deviceCondition(child, features));
      if (!children.length) return () => true;
      const matches = tree.operator === "and"
        ? ports => children.every(predicate => predicate(ports))
        : ports => children.some(predicate => predicate(ports));
      return tree.negated ? ports => !matches(ports) : matches;
    }
    if (features.vlan === false && ["vlan", "vlan-mode"].includes(tree.kind)) return () => false;
    const matchesPort = globalThis.NbCableEditorConnectionFilter.compilePort({
      kind: "group", operator: "and", children: [{...tree, negated: false}],
    }, features);
    const matches = ports => ports.some(matchesPort);
    return tree.negated ? ports => !matches(ports) : matches;
  }

  function devicePorts(device, ports = device?.ports ?? []) {
    return [{device, filter: device?.filter}, ...Array.from(ports, port => ({...port, device}))];
  }

  function compile(kind, rules, features = {}) {
    try {
      validate(kind, rules);
      const filters = globalThis.NbCableEditorConnectionFilter;
      const compiled = rules.filter(rule => rule.enabled !== false).map(rule => ({
        ...rule,
        matches: kind === "device" ? deviceCondition(rule.condition, features)
          : kind === "interface" ? filters.compilePort(rule.condition, features)
            : filters.compile(rule.condition, features),
      }));
      return (...args) => {
        const parameters = kind === "device" ? [devicePorts(...args)] : args;
        const result = {};
        for (const rule of compiled) {
          if (!rule.matches(...parameters)) continue;
          Object.assign(result, rule.actions);
          if (rule.halt) break;
        }
        return result;
      };
    } catch (failure) {
      const denied = kind === "device" ? {edit: false, interfaces: false, cables: false}
        : kind === "interface" ? {visible: false, edit: false, connect: false, disconnect: false}
          : {visible: false, edit: false, virtualPipe: false, hover: false, details: false};
      const evaluate = () => ({...denied});
      evaluate.error = failure.message;
      return evaluate;
    }
  }

  globalThis.NbCableEditorRules = {actionDefinitions, validate, normalize, compile};
})();
