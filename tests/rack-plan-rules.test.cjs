const assert = require("node:assert/strict");
const test = require("node:test");
require("../nbcableeditor/static/nbcableeditor/rack-plan.js");

class Control extends EventTarget {
  constructor(tag = "div", textContent = "") {
    super();
    Object.assign(this, {tag, textContent, children: [], dataset: {}, isConnected: true});
    this.classList = {toggle() {}, add() {}};
    this.style = {setProperty() {}};
  }

  get options() { return this.children; }
  get childElementCount() { return this.children.length; }
  add(...children) { this.append(...children); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event("close")); }
  focus() {}
  select() {}
  hasPointerCapture() { return false; }
  setPointerCapture() {}
  releasePointerCapture() {}
}

const controlNames = [
  "plan-select", "plan-view", "plan-opacity", "plan-manage", "plan-changes", "plan-apply", "plan-port-actions",
  "plan-dialog", "plan-dialog-close", "plan-dialog-title", "plan-dialog-content", "plan-error", "plan-bar",
  "plan-message", "plan-name", "plan-indicator", "plan-opacity-control", "plan-opacity-value", "create-form",
];
const settle = () => new Promise(resolve => setImmediate(resolve));
const stockCable = {id: 19, a: 1, b: 2, editable: true, deletable: true};

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

async function setup(t, operations = [], callbacks = {}) {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalOption = Object.getOwnPropertyDescriptor(globalThis, "Option");
  Object.defineProperty(globalThis, "location", {configurable: true, value: new URL("https://netbox.example/rack/1/")});
  Object.defineProperty(globalThis, "localStorage", {configurable: true, value: {
    getItem: () => JSON.stringify({id: 7, view: "plan"}), setItem() {},
  }});
  Object.defineProperty(globalThis, "Option", {configurable: true, value: class {
    constructor(text, value) { Object.assign(this, {text, value}); }
  }});
  t.after(() => {
    for (const [key, descriptor] of [["location", originalLocation], ["localStorage", originalStorage], ["Option", originalOption]]) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const controls = new Map(controlNames.map(name => [name, new Control()]));
  const ports = new Map([1, 2, 3, 4].map(id => [id, {
    id, name: "Port " + id, cableId: id <= 2 ? stockCable.id : null,
    occupancy: id <= 2 ? "cabled" : "free", blocked: false,
  }]));
  const plan = {id: 7, name: "Draft", canEdit: true, revision: 1, operations};
  t.mock.method(globalThis, "fetch", async url => ({
    ok: true, json: async () => url.endsWith("/7/") ? {plan} : {plans: [plan]},
  }));
  const writes = [];
  const errors = [];
  const planning = globalThis.NbCableEditorPlan({
    editor: new Control(), data: {
      planning: {url: "https://netbox.example/plans/", reportUrl: null},
      canAdd: true, canDelete: true, cableTypes: [], cableLengthUnits: [{value: "m", label: "Meters"}],
    },
    ports, cables: new Map([[stockCable.id, stockCable]]), portIdsByDataset: new Map(),
    get: key => controls.get(key), node: (tag, _className, text) => new Control(tag, text),
    button: (_className, text) => new Control("button", text),
    httpUrl: value => value, describe: port => port.name, canEnter: () => true,
    refresh() {}, redraw() {}, refreshRoutes() {}, onViewChange() {}, locatePort() {},
    setError: (_control, message) => { if (message) errors.push(message); },
    requestMutation: async (_url, body) => {
      writes.push(body);
      return body.action === "preview" ? {preview: {token: "preview-token", issues: []}}
        : {plan: {...plan, operations: body.operations ?? plan.operations}};
    },
    ...callbacks,
  });
  await planning.init();
  assert.equal(planning.inView(), true);
  const content = controls.get("plan-dialog-content");
  return {
    controls, ports, planning, writes, errors, content,
    click(label) {
      const control = find(content, element => element.tag === "button" && element.textContent === label);
      assert.ok(control, "Expected button " + label);
      control.dispatchEvent(new Event("click"));
    },
    submit() {
      const form = find(content, element => element.tag === "form");
      assert.ok(form, "Expected a plan form");
      form.dispatchEvent(new Event("submit", {cancelable: true}));
      return settle();
    },
  };
}

test("planned additions cannot be applied when either destination forbids connecting", async t => {
  const harness = await setup(t, [{id: "new", action: "add", a: 3, b: 4}], {
    portConnectAllowed: id => id !== 4,
  });
  assert.equal(harness.controls.get("plan-apply").disabled, true);
  harness.controls.get("plan-apply").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(harness.writes.length, 0);
  assert.match(harness.controls.get("plan-message").textContent, /disabled by the active rules/);
});

test("planned deletions check both disconnect permissions and ignore connect permissions", async t => {
  let disconnect = true;
  const harness = await setup(t, [{id: "delete", action: "delete", cable_id: stockCable.id}], {
    portConnectAllowed: () => false,
    portDisconnectAllowed: id => id !== 2 || disconnect,
  });
  assert.equal(harness.controls.get("plan-apply").disabled, false);
  disconnect = false;
  harness.controls.get("plan-apply").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(harness.writes.length, 0);
  assert.match(harness.controls.get("plan-message").textContent, /disabled by the active rules/);
});

test("planned moves require disconnect on the changed old end and connect on the changed new end", async t => {
  let connectAllowed = false;
  let disconnectAllowed = true;
  const harness = await setup(t, [{id: "move", action: "move", cable_id: stockCable.id, a: 1, b: 3}], {
    portConnectAllowed: id => id !== 3 || connectAllowed,
    portDisconnectAllowed: id => id !== 2 || disconnectAllowed,
  });
  assert.equal(harness.controls.get("plan-apply").disabled, true);
  connectAllowed = true;
  disconnectAllowed = false;
  harness.controls.get("plan-apply").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(harness.writes.length, 0);
});

test("moving one end preserves a fixed end whose connect and disconnect actions are disabled", async t => {
  const checkedConnect = [];
  const checkedDisconnect = [];
  const harness = await setup(t, [], {
    portConnectAllowed: id => { checkedConnect.push(id); return id !== 1; },
    portDisconnectAllowed: id => { checkedDisconnect.push(id); return id !== 1; },
  });
  harness.planning.select(harness.ports.get(2));
  harness.planning.select(harness.ports.get(3));
  assert.equal(harness.controls.get("plan-dialog-title").textContent, "Plan a cable move");
  await harness.submit();
  assert.equal(harness.writes.length, 1);
  const [operation] = harness.writes[0].operations;
  assert.equal(operation.action, "move");
  assert.equal(operation.a, 1);
  assert.equal(operation.b, 3);
  assert.equal(checkedConnect.includes(1), false);
  assert.equal(checkedDisconnect.includes(1), false);
  assert.equal(harness.controls.get("plan-apply").disabled, false);
});

test("Prevent Edit blocks a pending cable deletion", async t => {
  const harness = await setup(t, [{id: "delete", action: "delete", cable_id: stockCable.id}], {
    cableEditAllowed: () => false,
  });
  assert.equal(harness.controls.get("plan-apply").disabled, true);
  harness.controls.get("plan-apply").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(harness.writes.length, 0);
});

test("Prevent Edit removes stock cable move and unplug entry points", async t => {
  const harness = await setup(t, [], {cableEditAllowed: () => false});
  harness.planning.context(harness.ports.get(1));
  assert.equal(find(harness.content, element => element.textContent === "Plan unplug"), undefined);
  assert.equal(find(harness.content, element => element.textContent === "Choose new end"), undefined);
  harness.planning.select(harness.ports.get(3));
  assert.equal(harness.controls.get("plan-dialog-title").textContent, "Plan port actions");
  assert.equal(harness.writes.length, 0);
});

test("Connect To is rechecked when saving an already open addition form", async t => {
  let allowed = true;
  const harness = await setup(t, [], {portConnectAllowed: () => allowed});
  harness.planning.select(harness.ports.get(3));
  harness.planning.select(harness.ports.get(4));
  assert.equal(harness.controls.get("plan-dialog-title").textContent, "Plan a new cable");
  allowed = false;
  await harness.submit();
  assert.equal(harness.writes.length, 0);
  assert.match(harness.errors.at(-1), /disabled by the active rules/);
});

test("Disconnect From is rechecked when confirming an already open unplug dialog", async t => {
  let allowed = true;
  const harness = await setup(t, [], {portDisconnectAllowed: () => allowed});
  harness.planning.context(harness.ports.get(1));
  harness.click("Plan unplug");
  assert.equal(harness.controls.get("plan-dialog-title").textContent, "Plan to unplug cable");
  allowed = false;
  harness.click("Add unplug to plan");
  await settle();
  assert.equal(harness.writes.length, 0);
  assert.match(harness.errors.at(-1), /disabled by the active rules/);
});

test("rules are rechecked after preview and before applying a plan", async t => {
  let allowed = true;
  const harness = await setup(t, [{id: "new", action: "add", a: 3, b: 4}], {
    portConnectAllowed: () => allowed,
  });
  harness.controls.get("plan-apply").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].action, "preview");
  allowed = false;
  await harness.submit();
  assert.equal(harness.writes.length, 1);
  assert.match(harness.errors.at(-1), /disabled by the active rules/);
});

test("connection rules can prevent applying additions without a stock cable", async t => {
  const harness = await setup(t, [{id: "new", action: "add", a: 3, b: 4}], {
    operationAllowed: operation => operation.action !== "add",
  });
  assert.equal(harness.controls.get("plan-apply").disabled, true);
  harness.controls.get("plan-apply").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(harness.writes.length, 0);
  assert.match(harness.controls.get("plan-message").textContent, /disabled by the active rules/);
});

test("connection edit rules are rechecked when saving an open addition form", async t => {
  let allowed = true;
  const harness = await setup(t, [], {operationAllowed: () => allowed});
  harness.planning.select(harness.ports.get(3));
  harness.planning.select(harness.ports.get(4));
  assert.equal(harness.controls.get("plan-dialog-title").textContent, "Plan a new cable");
  allowed = false;
  await harness.submit();
  assert.equal(harness.writes.length, 0);
  assert.match(harness.errors.at(-1), /disabled by the active rules/);
});

test("blocked planned additions omit their edit and move actions", async t => {
  const harness = await setup(t, [{id: "new", action: "add", a: 3, b: 4}], {
    operationAllowed: () => false,
  });
  harness.planning.context(harness.ports.get(3));
  assert.equal(find(harness.content, element => element.textContent === "Edit planned cable"), undefined);
  assert.equal(find(harness.content, element => element.textContent === "Choose new end"), undefined);
  assert.ok(find(harness.content, element => element.textContent === "Remove connect from plan"));
});

test("connection details can be disabled while selecting a planned cable", async t => {
  const harness = await setup(t, [{id: "new", action: "add", a: 3, b: 4}], {
    operationDetailsAllowed: () => false,
  });
  harness.planning.inspectLine("new");
  assert.equal(harness.planning.activeLine(), "new");
  assert.notEqual(harness.controls.get("plan-dialog").open, true);
  assert.equal(harness.writes.length, 0);
});

test("connection edit rules are rechecked after plan preview", async t => {
  let allowed = true;
  const harness = await setup(t, [{id: "new", action: "add", a: 3, b: 4}], {
    operationAllowed: () => allowed,
  });
  harness.controls.get("plan-apply").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].action, "preview");
  allowed = false;
  await harness.submit();
  assert.equal(harness.writes.length, 1);
  assert.match(harness.errors.at(-1), /disabled by the active rules/);
});
