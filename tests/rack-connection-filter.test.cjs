const test = require("node:test");
const assert = require("node:assert/strict");
require("../nbcableeditor/static/nbcableeditor/rack-connection-filter.js");

const {empty, compile} = globalThis.NbCableEditorConnectionFilter;
const group = (operator, ...children) => ({kind: "group", operator, children});
const endpoint = (scope, criteria) => ({kind: "endpoint", endpoint: scope, criteria: match(criteria)});
const match = values => ({devices: [], deviceTypes: [], portRanges: "", ...values});
const cable = {id: 300, typeValue: "cat6", lengthValue: "10", lengthUnit: "ft"};
const a = {name: "1/1/12", device: {id: 10, deviceTypeId: 20}, untaggedVlan: {vid: 55}};
const b = {name: "eth-2", device: {filterDeviceId: 11, deviceTypeId: 21}, taggedVlans: [{vid: 10}]};

test("nested AND and OR combine symmetric device/type endpoints, VLAN, length and cable type", () => {
  const between = {kind: "between", a: match({deviceTypes: [20], portRanges: "1/1/1-1/1/24"}),
    b: match({devices: [11, 12]}), directional: false};
  const vlan = {kind: "vlan", endpoint: "any", membership: "untagged", ids: "50-70"};
  const materials = group("or", {kind: "cable-type", values: ["cat6a", "cat7"]}, {kind: "length", min: 3.048, max: 3.048});
  const filter = compile(group("and", between, vlan, materials));
  assert.equal(filter(cable, a, b), true);
  assert.equal(filter(cable, b, a), true);
  assert.equal(filter(cable, {...a, name: "2/1/12"}, b), false);
  assert.equal(filter(cable, {...a, untaggedVlan: {vid: 8}}, b), false);
  assert.equal(filter({...cable, lengthValue: "9"}, a, b), false);
  assert.equal(filter({...cable, lengthValue: "9", typeValue: "cat7"}, a, b), true);
  assert.equal(filter(cable, a, null), false);
  assert.equal(filter(cable, a, {...b, device: {filterDeviceId: 12}}), true);

  const directed = compile(group("and", {...between, directional: true}));
  assert.equal(directed(cable, a, b), true);
  assert.equal(directed(cable, b, a), false);
});

test("port selectors accept suffix ranges, short prefixed ranges and exact port names", () => {
  const allows = names => compile(group("and", endpoint("a", {portRanges: names})));
  assert.equal(allows("1-24")(cable, a, b), true);
  assert.equal(allows("1/1/1-24")(cable, a, b), true);
  assert.equal(allows("1/1/1-24")(cable, {...a, name: "2/1/12"}, b), false);
  assert.equal(allows("=ETH-2, mgmt")(cable, b, a), true);
  assert.equal(allows("=2-12")(cable, {...b, name: "eth-8"}, a), false);
  assert.equal(allows("=2-12")(cable, {...b, name: "2-12"}, a), true);
  assert.equal(allows("1-24")(cable, {...a, name: "1/1/25"}, b), false);
});

test("VLAN rules distinguish tagged, untagged and end scope, including tagged-all interfaces", () => {
  const allows = (endpoint, membership, ids) => compile(group("and", {kind: "vlan", endpoint, membership, ids}));
  assert.equal(allows("any", "untagged", "")(cable, a, b), true);
  assert.equal(allows("a", "tagged", "10")(cable, a, b), false);
  assert.equal(allows("b", "tagged", "10")(cable, a, b), true);
  assert.equal(allows("both", "any", "10,55")(cable, a, b), true);
  assert.equal(allows("both", "tagged", "10,55")(cable, a, b), false);
  const trunk = {...a, vlanMode: "tagged-all"};
  assert.equal(allows("a", "tagged", "10")(cable, trunk, b), true);
  assert.equal(allows("a", "tagged", "55")(cable, trunk, b), false);
});

test("globally disabled VLAN conditions cannot broaden an AND group", () => {
  const vlan = {kind: "vlan", endpoint: "any", membership: "untagged", ids: "55"};
  const device = endpoint("a", {devices: [10]});
  assert.equal(compile(group("and", device, vlan), {vlan: false})(cable, a, b), false);
  assert.equal(compile(group("or", device, vlan), {vlan: false})(cable, a, b), true);
});

test("an empty or invalid filter never matches all connections", () => {
  for (const filter of [
    null, empty(), group("and", group("or")), group("xor", endpoint("a", {devices: [10]})),
    group("or", endpoint("any", {devices: [10]}), {kind: "unknown"}),
    group("and", endpoint("a", {portRanges: "24-1"})),
    group("and", {kind: "vlan", endpoint: "any", membership: "untagged", ids: "4095"}),
    group("and", {kind: "length", min: null, max: null}),
  ]) assert.equal(compile(filter)(cable, a, b), false);
});

test("length criteria exclude unmeasured cables and convert supported units", () => {
  const filter = compile(group("and", {kind: "length", min: null, max: 3}));
  assert.equal(filter(cable, a, b), false);
  assert.equal(filter({...cable, lengthValue: "300", lengthUnit: "cm"}, a, b), true);
  assert.equal(filter({...cable, lengthValue: "120", lengthUnit: "in"}, a, b), false);
  assert.equal(filter({...cable, lengthValue: null, lengthUnit: "m"}, a, b), false);
  assert.equal(filter({...cable, lengthValue: "1", lengthUnit: ""}, a, b), false);
});
