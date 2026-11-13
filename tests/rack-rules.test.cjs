const test = require("node:test");
const assert = require("node:assert/strict");
require("../nbcableeditor/static/nbcableeditor/rack-connection-filter.js");
require("../nbcableeditor/static/nbcableeditor/rack-rules.js");

const {actionDefinitions, validate, normalize, compile} = globalThis.NbCableEditorRules;
const group = (...children) => ({kind: "group", operator: "and", children});
const endpoint = criteria => ({kind: "endpoint", endpoint: "any", criteria});
const rule = (actions, condition = group(), options = {}) => ({condition, actions, ...options});
const device = {id: 11, deviceTypeId: 21, filter: {deviceRoles: [{id: 31}]}};
const otherDevice = {id: 12, deviceTypeId: 22};
const port = {id: 41, name: "eth1", kind: "interface", device, untaggedVlan: {vid: 55}};
const otherPort = {id: 42, name: "eth2", kind: "interface", device: otherDevice};
const cable = {id: 51, typeValue: "cat6", lengthValue: 3, lengthUnit: "m"};

test("empty rule lists preserve all default behaviors", () => {
  assert.deepEqual(compile("interface", [])(port), {});
  assert.deepEqual(compile("connection", [])(cable, port, otherPort), {});
  assert.deepEqual(compile("device", [])(device), {});
});

test("ordered matching rules merge actions and the last matching value wins", () => {
  const evaluate = compile("interface", [
    rule({visible: false, connect: false}),
    rule({visible: true, color: "#113355"}, group(endpoint({devices: [11]}))),
    rule({visible: false, disconnect: false}, group(endpoint({devices: [12]}))),
  ]);
  assert.deepEqual(evaluate(port), {visible: true, connect: false, color: "#113355"});
  assert.deepEqual(evaluate(otherPort), {visible: false, connect: false, disconnect: false});
});

test("halt stops only after a matching enabled rule", () => {
  const evaluate = compile("connection", [
    rule({visible: false}, group(endpoint({devices: [99]})), {halt: true}),
    rule({edit: false}, group(), {enabled: false, halt: true}),
    rule({color: "#abcdef"}, group(), {halt: true}),
    rule({color: "#112233", edit: false}),
  ]);
  assert.deepEqual(evaluate(cable, port, otherPort), {color: "#abcdef"});
});

test("an empty condition applies to every element and can halt without actions", () => {
  const evaluate = compile("device", [rule({}, group(), {halt: true}), rule({edit: false})]);
  assert.deepEqual(evaluate(device), {});
  assert.deepEqual(evaluate({id: 77, ports: []}), {});
});

test("interface rules accept all formatting and connection actions", () => {
  const actions = {visible: true, edit: false, color: "#000001", icon: "rectangle", iconColor: "#ff0000",
    hideLabel: true, fontWeight: "bold", labelColor: "#123456", connect: false,
    disconnect: true, hideCable: true, virtualCable: true};
  assert.equal(validate("interface", [rule(actions)]), true);
  assert.deepEqual(compile("interface", [rule(actions)])(port), actions);
  assert.equal(actionDefinitions.interface.length, Object.keys(actions).length);
});

test("connection and device rules accept their full action sets", () => {
  const connections = {edit: false, virtualPipe: false, hover: false, details: false, visible: true,
    color: "#aabbcc", luminosity: 130, opacity: 0.6, lineStyle: "dotted", width: 3.5};
  const devices = {edit: false, grayBox: true, interfaces: true, cables: false, front: true, rear: false};
  assert.equal(validate("connection", [rule(connections)]), true);
  assert.equal(validate("device", [rule(devices)]), true);
  assert.deepEqual(compile("connection", [rule(connections)])(cable, port, otherPort), connections);
  assert.deepEqual(compile("device", [rule(devices)])(device), devices);
});

test("legacy filters convert to a negative rule and explicit empty lists take precedence", () => {
  const condition = group(endpoint({devices: [11]}));
  const legacyOptions = {legacyFilter: condition, legacyAction: "hide"};
  const converted = normalize("interface", undefined, legacyOptions);
  assert.equal(converted[0].condition.negated, true);
  assert.deepEqual(compile("interface", converted)(port), {});
  assert.deepEqual(compile("interface", converted)(otherPort), {visible: false});
  assert.deepEqual(normalize("interface", [], legacyOptions), []);
  assert.deepEqual(normalize("interface", undefined, {legacyFilter: group()}), []);
  assert.deepEqual(normalize("interface", undefined, {legacyFilter: group({kind: "group", operator: "or", children: []})}), []);
  assert.equal(condition.negated, undefined);
});

test("legacy port lock and mark actions preserve their behavior", () => {
  const legacyFilter = group(endpoint({devices: [11]}));
  const locked = normalize("interface", undefined, {legacyFilter});
  const marked = normalize("interface", undefined, {legacyFilter, legacyAction: "mark"});
  assert.deepEqual(compile("interface", locked)(otherPort), {edit: false, connect: false, disconnect: false});
  assert.deepEqual(compile("interface", marked)(otherPort), {icon: "red-x"});
  const connection = normalize("connection", undefined, {legacyFilter});
  assert.deepEqual(compile("connection", connection)(cable, otherPort, otherPort), {visible: false});
});

test("legacy Block editing locks metadata together with connect and disconnect", () => {
  const legacyFilter = group(endpoint({devices: [11]}));
  const imported = normalize("interface", undefined, {legacyFilter, legacyAction: "block"});
  assert.deepEqual(compile("interface", imported)(port), {});
  assert.deepEqual(compile("interface", imported)(otherPort), {edit: false, connect: false, disconnect: false});
  const explicit = [rule({edit: false, connect: true, disconnect: true})];
  assert.equal(validate("interface", explicit), true);
  assert.deepEqual(compile("interface", explicit)(port), {edit: false, connect: true, disconnect: true});
  assert.throws(() => validate("interface", [rule({edit: "false"})]));
});

test("normalization applies defaults and keeps source arrays immutable", () => {
  const source = [rule({visible: true})];
  const normalized = normalize("interface", source);
  assert.equal(normalized[0].name, "");
  assert.equal(normalized[0].enabled, true);
  assert.equal(normalized[0].halt, false);
  normalized[0].actions.visible = false;
  assert.equal(source[0].actions.visible, true);
});

test("device conditions match metadata without ports and module metadata on ports", () => {
  const metadata = compile("device", [rule({grayBox: true}, group(endpoint({deviceTypes: [21], deviceRoles: [31]})))]);
  assert.deepEqual(metadata(device), {grayBox: true});
  assert.deepEqual(metadata(otherDevice), {});
  const moduleCondition = group(endpoint({moduleTypes: [61], moduleTags: [71], interfaces: [41]}));
  const withModule = {...port, filter: {interfaceId: 41, moduleTypes: [{id: 61}], moduleTags: [{id: 71}]}};
  const modules = compile("device", [rule({edit: false}, moduleCondition)]);
  assert.deepEqual(modules(device, [withModule]), {edit: false});
  assert.deepEqual(modules(device, [port]), {});
});

test("device NOT conditions negate the match across the whole device", () => {
  const condition = group({...endpoint({portRanges: "eth1"}), negated: true});
  const evaluate = compile("device", [rule({grayBox: true}, condition)]);
  assert.deepEqual(evaluate(device, [port, {...port, name: "eth2"}]), {});
  assert.deepEqual(evaluate(device, [{...port, name: "eth2"}]), {grayBox: true});
  const invertedGroup = {...group(endpoint({portRanges: "eth1"})), negated: true};
  assert.deepEqual(compile("device", [rule({grayBox: true}, invertedGroup)])(device, [port]), {});
});

test("device trace and VLAN conditions inspect the interfaces and respect global VLAN disable", () => {
  const tracedPort = {...port, filterTrace: {any: [{device: otherDevice}]}};
  const trace = {kind: "trace", scope: "any", criteria: {deviceTypes: [22]}};
  const vlan = {kind: "vlan", endpoint: "any", membership: "untagged", ids: "55"};
  const condition = group(trace, vlan);
  assert.deepEqual(compile("device", [rule({edit: false}, condition)])(device, [tracedPort]), {edit: false});
  assert.deepEqual(compile("device", [rule({edit: false}, condition)], {vlan: false})(device, [tracedPort]), {});
});

test("unknown actions, invalid values and malformed conditions are rejected and fail closed", () => {
  const invalid = [
    rule({opacity: 1.1}), rule({width: true}), rule({luminosity: NaN}), rule({color: "red"}),
    rule({lineStyle: "script"}), rule({edit: "false"}), rule({unknown: true}),
    rule({edit: true}, group(endpoint({portRanges: "24-1"}))),
    rule({edit: true}, group({kind: "vlan", endpoint: "any", membership: "tagged", ids: "4095"})),
    {...rule({edit: true}), halt: "yes"}, {...rule({edit: true}), malicious: true},
  ];
  for (const entry of invalid) {
    assert.throws(() => validate("connection", [entry]));
    const evaluate = compile("connection", [entry]);
    assert.equal(evaluate(cable, port, otherPort).edit, false);
    assert.equal(typeof evaluate.error, "string");
  }
  assert.throws(() => validate("interface", [rule({}, group({kind: "cable-type", values: ["cat6"]}))]));
  assert.equal(compile("interface", [rule({edit: "yes"})])(port).connect, false);
});

test("rule and condition complexity limits are enforced", () => {
  assert.throws(() => validate("device", Array.from({length: 101}, () => rule({}))));
  let nested = group(endpoint({devices: [11]}));
  for (let index = 0; index < 8; index++) nested = group(nested);
  assert.throws(() => validate("device", [rule({}, nested)]));
  assert.throws(() => validate("device", [rule({}, group(...Array.from({length: 100}, () => endpoint({devices: [11]}))))]));
});
