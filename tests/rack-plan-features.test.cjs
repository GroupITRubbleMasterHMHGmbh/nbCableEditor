const assert = require("node:assert/strict");
const test = require("node:test");
require("../nbcableeditor/static/nbcableeditor/rack-plan.js");

class Control extends EventTarget {
  constructor(textContent = "") {
    super();
    this.textContent = textContent;
    this.children = [];
    this.isConnected = true;
    this.classList = {toggle() {}};
  }

  get options() { return this.children; }
  add(...children) { this.append(...children); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  showModal() { this.open = true; }
}

globalThis.location = new URL("https://netbox.example/rack/1/");
globalThis.Option = class {
  constructor(text, value) { Object.assign(this, {text, value}); }
};

const planControls = ["plan-select", "plan-view", "plan-opacity", "plan-manage", "plan-changes",
  "plan-apply", "plan-port-actions"];
const dialogControls = ["plan-dialog", "plan-dialog-close", "plan-dialog-title", "plan-dialog-content", "plan-error"];

test("calculator-only racks open the inventory report without initializing the planner", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => ({
    ok: true, json: async () => ({report: {details: []}}),
  }));
  const controls = new Map([...dialogControls, "plan-report"].map(name => [name, new Control()]));
  const planning = globalThis.NbCableEditorPlan({
    data: {planning: {url: null, reportUrl: "https://netbox.example/calculator/"}},
    get: key => controls.get(key),
    node: (_tag, _class, text) => new Control(text),
    httpUrl: url => url,
    setError: () => {},
  });
  assert.equal(planning, null);
  assert.equal(fetch.mock.callCount(), 0);

  controls.get("plan-report").dispatchEvent(new Event("click"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controls.get("plan-dialog").open, true);
  assert.equal(controls.get("plan-dialog-title").textContent, "Cable calculator");
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fetch.mock.calls[0].arguments[0], "https://netbox.example/calculator/");
  const [toolbar] = controls.get("plan-dialog-content").children;
  const download = toolbar.children.at(-1);
  assert.equal(download.href, "https://netbox.example/calculator/?format=csv");
});

test("planner initializes without the calculator toolbar control", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => ({
    ok: true, json: async () => ({plans: []}),
  }));
  const controls = new Map([...dialogControls, ...planControls].map(name => [name, new Control()]));
  const planning = globalThis.NbCableEditorPlan({
    data: {planning: {url: "https://netbox.example/plans/", reportUrl: null}},
    get: key => controls.get(key),
    httpUrl: url => url,
  });

  await planning.init();
  assert.equal(planning.inView(), false);
  assert.equal(controls.get("plan-view").value, "stock");
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fetch.mock.calls[0].arguments[0], "https://netbox.example/plans/");
});

test("a hidden planning toolbar retains the chosen plan and uses Inventory", async t => {
  const plan = {id: 42, name: "Draft", canEdit: true, operations: []};
  t.mock.method(globalThis, "fetch", async url => ({
    ok: true, json: async () => url.endsWith("/42/") ? {plan} : {plans: [plan]},
  }));
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {getItem: () => JSON.stringify({id: plan.id, view: "plan"}), setItem() {}},
  });
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else delete globalThis.localStorage;
  });
  const controls = new Map([
    ...dialogControls, ...planControls, "plan-bar", "plan-message", "plan-name", "plan-indicator",
    "plan-opacity-control", "plan-opacity-value",
  ].map(name => [name, new Control()]));
  const editor = {dataset: {}, querySelectorAll: () => [], style: {setProperty() {}}};
  let visible = false;
  const planning = globalThis.NbCableEditorPlan({
    editor,
    data: {planning: {url: "https://netbox.example/plans/", reportUrl: null}},
    get: key => controls.get(key),
    httpUrl: url => url,
    planningControlsVisible: () => visible,
    canEnter: () => true,
    refresh() {},
    refreshRoutes() {},
    onViewChange() {},
  });

  await planning.init();
  assert.equal(editor.dataset.planView, "stock");
  assert.equal(controls.get("plan-select").value, plan.id);
  assert.equal(planning.inView(), false);

  visible = true;
  planning.toolbarChanged();
  const view = controls.get("plan-view");
  view.value = "mixed";
  view.dispatchEvent(new Event("change"));
  assert.equal(planning.inView(), true);

  visible = false;
  planning.toolbarChanged();
  assert.equal(editor.dataset.planView, "stock");
  assert.equal(controls.get("plan-select").value, plan.id);
  assert.equal(controls.get("plan-bar").hidden, true);
  assert.equal(planning.inView(), false);
});
