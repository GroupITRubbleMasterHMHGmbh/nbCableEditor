const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../nbcableeditor/static/nbcableeditor/rack.js"), "utf8");

function functionSource(name) {
  const start = source.indexOf("  function " + name + "(");
  assert.ok(start >= 0, "Runtime function exists: " + name);
  const remainder = source.slice(start);
  const next = remainder.slice(1).search(/\n  (?:async )?function /);
  return remainder.slice(0, next + 1);
}

function runtime({operation, original, actions = {}, evaluate = () => actions, interfaceEffects = {}, deviceEffects = {}} = {}) {
  const portA = {id: 1, device: {id: 10}};
  const portB = {id: 2, device: {id: 20}};
  const context = {
    operations: [operation], originals: original ? [original] : [], effects: actions,
    evaluate, interfaceEffects, deviceEffects, localPorts: [portA, portB],
  };
  vm.createContext(context);
  vm.runInContext(`
    const cables = new Map(originals.map(cable => [cable.id, cable]));
    const ports = new Map(localPorts.map(port => [port.id, port]));
    const rackPlan = {lineOperations: () => operations};
    const linkedCableId = null;
    const connectionRuleEvaluator = evaluate;
    function connectionActions() { return effects; }
    function interfaceActions(id) { return interfaceEffects[id] ?? {}; }
    function deviceActions(id) { return deviceEffects[id] ?? {}; }
    function cableMatchesDevice() { return true; }
    function cableEndpoint(cable, end) { return ports.get(cable[end.toLowerCase()]); }
    function baseCableColor() { return "#7b63df"; }
    ${["cableVisibleByRules", "plannedRuleLine", "plannedRuleLines", "cableColor", "applyCableFormat"].map(functionSource).join("\n")}
    globalThis.runtime = {plannedRuleLine, plannedRuleLines, cableColor, applyCableFormat};
  `, context);
  return {...context.runtime, context};
}

test("cable-backed planned moves evaluate rules against the proposed endpoints", () => {
  const effects = {visible: true, color: "#aabbcc", width: 8};
  const {plannedRuleLines} = runtime({
    original: {id: 7, a: 1, b: 2, typeValue: "cat6"},
    operation: {id: "move", action: "move", cable_id: 7, a: 2, b: 1},
    actions: effects,
    evaluate(cable, a, b) {
      assert.equal(cable.id, 7);
      assert.equal(cable.typeValue, "cat6");
      assert.equal(a.id, 2);
      assert.equal(b.id, 1);
      return effects;
    },
  });
  const [line] = plannedRuleLines();
  assert.equal(line.actions, effects);
  assert.equal(line.cable.id, 7);
  assert.equal(line.cable.a, 2);
  assert.equal(line.cable.typeValue, "cat6");
});

test("proposed additions match rules using normalized metadata and proposed ports", () => {
  const {plannedRuleLines} = runtime({
    operation: {id: "add", action: "add", a: 1, b: 2, type: "cat6a", length: "12", length_unit: "m"},
    evaluate(cable, a, b) {
      assert.equal(cable.id, "plan:add");
      assert.equal(cable.typeValue, "cat6a");
      assert.equal(cable.lengthValue, "12");
      assert.equal(cable.lengthUnit, "m");
      assert.equal(a.id, 1);
      assert.equal(b.id, 2);
      return {color: "#123456"};
    },
  });
  assert.equal(plannedRuleLines()[0].actions.color, "#123456");
});

test("single-operation rule evaluation is independent of plan enumeration", () => {
  const operation = {id: "new", action: "add", a: 1, b: 2, type: "cat6a"};
  const {plannedRuleLine, context} = runtime({operation, evaluate: () => ({edit: false, details: false})});
  vm.runInContext("rackPlan.lineOperations = () => { throw new Error('recursive enumeration'); };", context);
  const result = plannedRuleLine(operation);
  assert.equal(result.cable.typeValue, "cat6a");
  assert.equal(result.actions.edit, false);
  assert.equal(result.actions.details, false);
});

test("planned deletion evaluation retains the original endpoints and cable attributes", () => {
  const operation = {id: "remove", action: "delete", cable_id: 7};
  const {plannedRuleLine} = runtime({
    operation, original: {id: 7, a: 1, b: 2, typeValue: "cat6"},
    evaluate(cable, a, b) {
      assert.equal(cable.id, 7);
      assert.equal(cable.typeValue, "cat6");
      assert.equal(a.id, 1);
      assert.equal(b.id, 2);
      return {edit: false};
    },
  });
  assert.equal(plannedRuleLine(operation).actions.edit, false);
});

test("connection, device and interface cable hiding exclude proposed plan lines", () => {
  const operation = {id: "add", action: "add", a: 1, b: 2};
  assert.equal(runtime({operation, actions: {visible: false}}).plannedRuleLines().length, 0);
  assert.equal(runtime({operation, deviceEffects: {10: {cables: false}}}).plannedRuleLines().length, 0);
  assert.equal(runtime({operation, interfaceEffects: {2: {hideCable: true}}}).plannedRuleLines().length, 0);
});

test("hiding interface symbols preserves the planned cable", () => {
  const {plannedRuleLines} = runtime({
    operation: {id: "add", action: "add", a: 1, b: 2},
    interfaceEffects: {1: {visible: false}, 2: {visible: false}},
    deviceEffects: {10: {interfaces: false}},
  });
  assert.equal(plannedRuleLines().length, 1);
});

test("planned cable color defaults and luminosity follow the active rules", () => {
  const {cableColor} = runtime();
  assert.equal(cableColor({}, {}, "#7b63df"), "#7b63df");
  assert.equal(cableColor({}, {color: "#204060"}, "#7b63df"), "#204060");
  assert.equal(cableColor({}, {color: "#204060", luminosity: 50}, "#7b63df"), "#102030");
});

test("proposed cable strokes accept explicit width opacity and dash formatting", () => {
  const {applyCableFormat} = runtime();
  const stroke = {style: {}};
  const actions = {width: 8, opacity: 0.25, lineStyle: "dashed"};
  applyCableFormat(stroke, {id: "plan:add"}, false, actions);
  assert.equal(stroke.style.strokeWidth, "calc(8px * var(--re-rack-cable-scale))");
  assert.equal(stroke.style.opacity, 0.25);
  assert.equal(stroke.style.strokeDasharray, "7 5");
  const outline = {style: {}};
  applyCableFormat(outline, {id: "plan:add"}, true, actions);
  assert.equal(outline.style.strokeWidth, "calc(9.5px * var(--re-rack-cable-scale))");
});

test("planned cable routing reserves clearance for its formatted width", () => {
  const {context} = runtime({
    operation: {id: "add", action: "add", a: 1, b: 2},
    actions: {width: 8, color: "#204060", opacity: 0.3},
  });
  vm.runInContext(`
    rackPlan.activeLine = () => null;
    rackPlan.pointerLine = () => null;
    const geometry = {
      endpoints: new Map([[1, {port: 1, x: 0, y: 0}], [2, {port: 2, x: 100, y: 100}]]),
      obstacles: [], bounds: {}, protectedAreas: [], strategy: "pcb",
      spacing: 5, horizontalSpacing: 10, deviceClearance: 25,
    };
    let drawnPlanGeometry;
    let drawnPlanKey;
    let routeOptions;
    let rendered;
    const defaultCableGap = 4.5;
    const parallelCableGap = 4.5;
    const extraHorizontalGap = 5;
    const deviceEdgeClearance = 25;
    function cableDrawingScale() { return 1; }
    function cableShape() { return {d: "M 0 0 L 100 100"}; }
    function wire(d, className, color) {
      return {style: {}, dataset: {}, className, color, classList: {add() {}}, getAttribute: () => d};
    }
    function cableHex(cable) { return cable.color || ""; }
    const document = {createDocumentFragment: () => ({items: [], append(...items) { this.items.push(...items); }})};
    const planLayer = {replaceChildren: fragment => { rendered = fragment.items; }};
    const planPointerLayer = {replaceChildren() {}};
    globalThis.NbCableEditorRouting = {
      routeCables(connections, obstacles, bounds, protectedAreas, options) {
        routeOptions = options;
        return new Map(connections.map(connection => [connection.id, [connection.a, connection.b]]));
      },
    };
    ${functionSource("cableStrokes")}
    ${functionSource("drawPlanWires")}
    drawPlanWires();
    globalThis.drawing = {routeOptions, rendered};
  `, context);
  assert.ok(context.drawing.routeOptions.spacing >= 14);
  assert.ok(context.drawing.routeOptions.horizontalSpacing >= 19);
  assert.ok(context.drawing.routeOptions.deviceClearance >= 30.25);
  const stroke = context.drawing.rendered.find(item => item.className.includes("re-rack-wire-plan"));
  assert.equal(stroke.color, "#204060");
  assert.equal(stroke.style.opacity, 0.3);
  assert.equal(stroke.style.strokeWidth, "calc(8px * var(--re-rack-cable-scale))");
});
