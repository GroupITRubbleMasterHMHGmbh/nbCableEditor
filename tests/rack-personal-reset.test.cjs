const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../nbcableeditor/static/nbcableeditor/rack-saved-views.js"), "utf8");

class Control extends EventTarget {
  classes = new Set();
  attributes = new Map();
  classList = {toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name)};
  ownerDocument = {createElement: () => new Control()};
  options = [];
  replaceChildren(...options) { this.options = options; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  add(option) { this.options.push(option); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  click() { this.dispatchEvent(new Event("click")); }
}

function rackViewController(query, defaultView, {preferSystemView = false, views = [], sharedCableView, canSwitch = () => true} = {}) {
  const location = new URL("https://netbox.example/rack/1/" + query);
  const history = {
    state: {reRackDeviceImages: "hidden", reRackEditor: {viewId: null}, unrelated: true},
    replaceState(state, _title, url) {
      this.state = state;
      location.href = String(url);
    },
  };
  const context = {location, history, URL, URLSearchParams,
    Option: class { constructor(text, value) { Object.assign(this, {text, value}); } }};
  vm.runInNewContext(source, context);
  const controls = new Map();
  const get = key => {
    if (!controls.has(key)) controls.set(key, new Control());
    return controls.get(key);
  };
  const applied = [];
  const resetSettings = {};
  const resets = [];
  const controller = context.NbCableEditorSavedViews.mount({
    get,
    config: {canManage: false, views: defaultView ? [defaultView, ...views] : views},
    capture: () => ({rack: {devices: "42"}}),
    clearPersonal: followDefault => { resets.push(followDefault); return resetSettings; },
    preferSystemView, sharedCableView,
    apply: settings => applied.push(settings),
    canSwitch,
    requestMutation: () => assert.fail("A personal reset must not mutate the shared view"),
  });
  return {location, history, get, applied, controller, resetSettings, resets};
}

test("a rack reader can clear a personal view and load system defaults", () => {
  const {location, history, get, applied, controller, resetSettings, resets} =
    rackViewController("?view=personal&devices=42&face=rear&vlan=80&other=keep");
  assert.equal(get("saved-view-manage").hidden, false);
  assert.equal(get("saved-view-shared").hidden, true);
  assert.equal(get("saved-view-shared").disabled, true);
  get("saved-view-manage").click();
  assert.equal(get("saved-view-reset-rack-default").hidden, true);
  get("saved-view-reset-system").click();
  assert.deepEqual(resets, [false]);
  assert.equal(controller.activeId, null);
  assert.equal(applied.at(-1), resetSettings);
  assert.equal(location.search, "?view=personal&other=keep");
  assert.equal(history.state.reRackDeviceImages, null);
  assert.equal(history.state.reRackEditor, null);
  assert.equal(history.state.unrelated, true);
});

test("reset to rack default follows the configured default and discards the prior personal snapshot", () => {
  const defaultView = {id: 7, name: "Standard", isDefault: true, settings: {rack: {face: "rear"}}};
  const {location, get, applied, controller, resetSettings, resets} =
    rackViewController("?view=personal&devices=42", defaultView);
  get("saved-view-manage").click();
  assert.equal(get("saved-view-reset-rack-default").hidden, false);
  get("saved-view-reset-rack-default").click();
  assert.deepEqual(resets, [true]);
  assert.equal(location.search, "");
  assert.equal(controller.activeId, 7);
  assert.equal(applied.at(-1), defaultView.settings);
  const select = get("saved-view-select");
  select.value = "personal";
  select.dispatchEvent(new Event("change"));
  assert.equal(applied.at(-1), resetSettings);
});

test("a saved system preference wins on the bare rack URL and explicit saved view links still open", () => {
  const defaultView = {id: 7, name: "Standard", isDefault: true, settings: {rack: {face: "rear"}}};
  assert.equal(rackViewController("", defaultView).controller.activeId, 7);
  const preference = {preferSystemView: true};
  assert.equal(rackViewController("", defaultView, preference).controller.activeId, null);
  assert.equal(rackViewController("?view=7", defaultView, preference).controller.activeId, 7);
  assert.equal(rackViewController("?face=front", defaultView).controller.activeId, null);
});

test("global views have independent picker IDs even when their database IDs match", () => {
  const local = {id: 7, name: "Rack", isDefault: true, settings: {rack: {face: "front"}}};
  const global = {id: "global-7", name: "Global", isGlobal: true, settings: {rack: {face: "rear"}}};
  const {location, get, applied, controller} = rackViewController("?view=global-7", local, {views: [global]});
  assert.equal(controller.initialSettings, global.settings);
  const select = get("saved-view-select");
  assert.equal(select.options.at(-1).text, "Global (global)");
  select.value = "7";
  select.dispatchEvent(new Event("change"));
  assert.equal(location.search, "?view=7");
  assert.equal(applied.at(-1), local.settings);
});

test("shared cable links restore the captured view and remove the token when switching away", () => {
  const global = {id: "global-7", name: "Global", isGlobal: true, settings: {rack: {face: "rear"}}};
  const sharedCableView = {token: "123abc", cableId: 17, settings: {selectedConnections: [17]}};
  const {location, get, applied, controller} = rackViewController(
    "?cableView=123abc", null, {views: [global], sharedCableView},
  );
  assert.equal(controller.activeId, "share-123abc");
  assert.equal(controller.initialSettings, sharedCableView.settings);
  const select = get("saved-view-select");
  select.value = global.id;
  select.dispatchEvent(new Event("change"));
  assert.equal(location.search, "?view=global-7");
  assert.equal(applied.at(-1), global.settings);
  select.value = "share-123abc";
  select.dispatchEvent(new Event("change"));
  assert.equal(location.search, "?cableView=123abc");
  assert.equal(applied.at(-1), sharedCableView.settings);
});

test("global shortcuts show only pinned views and track the default and picker selection", () => {
  const first = {id: "global-5", name: "Alpha", isGlobal: true, isDefault: true, showInToolbar: true, settings: {rack: {face: "rear"}}};
  const second = {id: "global-6", name: "Zulu", isGlobal: true, showInToolbar: true, settings: {rack: {face: "both"}}};
  const unpinned = {id: "global-7", name: "Unpinned", isGlobal: true, settings: {}};
  let allowed = false;
  const {location, get, applied, controller} =
    rackViewController("", first, {views: [second, unpinned], canSwitch: () => allowed});
  const [alpha, zulu] = get("saved-view-buttons").options;
  assert.deepEqual(get("saved-view-buttons").options.map(button => button.textContent), ["Alpha", "Zulu"]);
  assert.equal(get("saved-view-shortcuts").hidden, false);
  assert.equal(controller.activeId, first.id);
  assert.equal(alpha.attributes.get("aria-pressed"), "true");
  assert.equal(alpha.classes.has("active"), true);
  zulu.click();
  assert.equal(controller.activeId, first.id);
  allowed = true;
  zulu.click();
  assert.equal(location.search, "?view=global-6");
  assert.equal(applied.at(-1), second.settings);
  assert.equal(zulu.attributes.get("aria-pressed"), "true");
  assert.equal(alpha.attributes.get("aria-pressed"), "false");
  const select = get("saved-view-select");
  select.value = unpinned.id;
  select.dispatchEvent(new Event("change"));
  assert.equal(zulu.attributes.get("aria-pressed"), "false");
  assert.equal(zulu.classes.has("active"), false);
  assert.equal(controller.activeId, unpinned.id);
});
