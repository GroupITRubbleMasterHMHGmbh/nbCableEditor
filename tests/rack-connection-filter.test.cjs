const test = require("node:test");
const assert = require("node:assert/strict");
require("../nbcableeditor/static/nbcableeditor/rack-connection-filter.js");

const {empty, compile, compilePort, endpointPort} = globalThis.NbCableEditorConnectionFilter;
const group = (operator, ...children) => ({kind: "group", operator, children});
const endpoint = (scope, criteria) => ({kind: "endpoint", endpoint: scope, criteria: match(criteria)});
const match = values => ({devices: [], deviceTypes: [], portRanges: "", ...values});
const cable = {id: 300, typeValue: "cat6", lengthValue: "10", lengthUnit: "ft"};
const a = {name: "1/1/12", device: {id: 10, deviceTypeId: 20}, untaggedVlan: {vid: 55}};
const b = {name: "eth-2", device: {filterDeviceId: 11, deviceTypeId: 21}, taggedVlans: [{vid: 10}]};

test("rack payload endpoints provide the same device and interface choices to both editors", () => {
  const remote = endpointPort({
    portId: 37, portName: "Ethernet2", portUrl: "/dcim/interfaces/37/",
    deviceName: "Remote switch", deviceType: "Switch", deviceTypeId: 21, filterDeviceId: 11,
    rackName: "Remote rack", deviceUrl: "/dcim/devices/11/",
    deviceFilter: {deviceRoles: [{id: 5, name: "Access"}]},
    filter: {interfaceId: 37, modules: [{id: 7, name: "Line card"}]},
  });
  const criteria = {devices: [11], deviceTypes: [21], deviceRoles: [5], interfaces: [37], modules: [7]};
  assert.equal(compile(group("and", endpoint("b", criteria)))(cable, a, remote), true);
  assert.equal(compilePort(group("and", endpoint("any", criteria)))(remote), true);
  assert.equal(remote.name, "Ethernet2");
  assert.equal(remote.device.rackName, "Remote rack");
});

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

test("missing and empty filter trees match all items, ignoring empty nested branches", () => {
  for (const filter of [null, undefined, empty(), group("or"), group("and", group("or", group("and")))]) {
    assert.equal(compile(filter)(cable, a, b), true);
    assert.equal(compilePort(filter)(a), true);
  }
  const noMatch = endpoint("any", {devices: [19]});
  const match = endpoint("any", {devices: [10]});
  const emptyBranch = group("or", group("and"));
  assert.equal(compile(group("or", emptyBranch, noMatch))(cable, a, b), false);
  assert.equal(compilePort(group("or", emptyBranch, noMatch))(a), false);
  assert.equal(compile(group("and", emptyBranch, match))(cable, a, b), true);
  assert.equal(compilePort(group("and", emptyBranch, match))(a), true);
});

test("invalid filters do not match connections", () => {
  for (const filter of [
    group("xor", endpoint("a", {devices: [10]})),
    group("or", endpoint("any", {devices: [10]}), {kind: "unknown"}),
    group("and", endpoint("a", {portRanges: "24-1"})),
    group("and", {kind: "vlan", endpoint: "any", membership: "untagged", ids: "4095"}),
    group("and", {kind: "length", min: null, max: null}),
  ]) assert.equal(compile(filter)(cable, a, b), false);
});

test("trace criteria distinguish next and later devices and work for cables and ports", () => {
  const panel = {name: "Rear 1", device: {id: 12, deviceTypeId: 22}};
  const outlet = {name: "Outlet 3", device: {id: 13, deviceTypeId: 23, filter: {deviceTags: [{id: 31}]}}};
  const client = {name: "eth0", device: {id: 14, deviceTypeId: 24}};
  const filterTrace = {next: [panel, outlet], any: [panel, outlet, client]};
  const tracedCable = {...cable, filterTrace};
  const tracedPort = {...a, filterTrace};
  const trace = (scope, criteria) => ({kind: "trace", scope, criteria: match(criteria)});
  const outletRule = trace("next", {deviceTypes: [23], deviceTags: [31], portRanges: "Outlet 1-5"});
  const clientRule = trace("any", {deviceTypes: [24]});
  const localRule = endpoint("any", {devices: [10]});

  assert.equal(compile(group("and", outletRule, clientRule, localRule))(tracedCable, a, b), true);
  assert.equal(compilePort(group("and", outletRule, clientRule, localRule))(tracedPort), true);
  assert.equal(compile(group("and", {...clientRule, scope: "next"}))(tracedCable, a, b), false);
  assert.equal(compilePort(group("and", {...clientRule, scope: "next"}))(tracedPort), false);
  assert.equal(compile(group("and", outletRule))(cable, a, b), false);
  assert.equal(compilePort(group("and", outletRule))(a), false);
  assert.equal(compilePort(group("and", trace("any", {deviceTypes: [24], deviceTags: [31]})))(tracedPort), false);
  assert.equal(compilePort(group("or", trace("next", {deviceTypes: [99]}), clientRule))(tracedPort), true);
});

test("geographic trace rules distinguish terminal destinations from stops along the route", () => {
  const stop = tracePlace => ({device: {filter: {tracePlace}}});
  const origin = stop({rackId: 1, locationId: 11, rackLocationId: 11, siteId: 21});
  const panel = stop({rackId: 2, locationId: 12, rackLocationId: 14, siteId: 21});
  const destination = stop({rackId: null, locationId: 13, siteId: 22});
  const filterTrace = {ends: [destination], along: [origin, panel, destination]};
  const current = {rackId: 1, locationId: 11, siteId: 21};
  for (const [scope, values, expected] of [
    ["end-outside-rack", [], true],
    ["end-outside-location", [], true],
    ["end-outside-site", [], true],
    ["end-in-current-rack", [], false],
    ["end-in-current-location", [], false],
    ["end-in-current-site", [], false],
    ["end-in-racks", [2], false],
    ["end-in-locations", [11, 13], true],
    ["end-in-sites", [21, 22], true],
    ["along-current-rack", [], true],
    ["along-current-location", [], true],
    ["along-current-site", [], true],
    ["along-racks", [2, 3], true],
    ["along-locations", [13], true],
    ["along-sites", [21], true],
    ["along-racks-in-locations", [14], true],
    ["along-racks-in-locations", [12], false],
    ["along-racks-in-locations", [13], false],
  ]) {
    const rule = group("and", {kind: "trace", scope, values});
    assert.equal(compile(rule, current)({...cable, filterTrace}), expected, scope);
    assert.equal(compilePort(rule, current)({...a, filterTrace}), expected, scope);
  }
  const localRule = group("and", {kind: "trace", scope: "end-in-current-rack"});
  assert.equal(compile(localRule, current)({...cable, filterTrace: {...filterTrace, ends: [origin, destination]}}), true);
  const rackRule = group("and", {kind: "trace", scope: "end-in-racks", values: [2]});
  assert.equal(compile(rackRule, current)({...cable, filterTrace: {...filterTrace, ends: [panel]}}), true);
  assert.equal(compile(group("and", {...rackRule.children[0], values: [], negated: true}), current)({...cable, filterTrace}), false);
});

test("outside trace rules distinguish unknown geography from a known unassigned location", () => {
  const current = {rackId: 1, locationId: 11, siteId: 21};
  const outside = group("and", {kind: "trace", scope: "end-outside-location"});
  const data = (...places) => ({filterTrace: {
    ends: places.map(tracePlace => ({device: {filter: {tracePlace}}})),
    along: [{device: {filter: {tracePlace: {locationId: 12}}}}],
  }});
  assert.equal(compile(outside, current)(data({rackId: 2, siteId: 21})), false);
  assert.equal(compile(outside, current)(data({locationId: null})), true);
  assert.equal(compile(outside, current)(data()), false);
  assert.equal(compile(outside, {...current, locationId: null})(data({locationId: 12})), false);
});

test("NOT applies to conditions and whole groups, while empty negated groups are ignored", () => {
  const not = rule => ({...rule, negated: true});
  const local = endpoint("any", {devices: [10]});
  const remote = endpoint("any", {devices: [99]});
  const cat6 = {kind: "cable-type", values: ["cat6"]};
  assert.equal(compile(group("and", local, not(cat6)))(cable, a, b), false);
  assert.equal(compile(group("and", local, not(cat6)))({...cable, typeValue: "cat7"}, a, b), true);
  assert.equal(compilePort(group("and", not(group("or", not(local), remote))))(a), true);
  assert.equal(compilePort(group("and", not(group("or", not(local), remote))))(b), false);
  assert.equal(compilePort(not(group("or", local, remote)))(a), false);
  assert.equal(compilePort(not(group("or", local, remote)))(b), true);
  assert.equal(compilePort(not(group("or", not(group("and")))))(a), true);
  assert.equal(compilePort(group("or", not(group("and")), remote))(a), false);
  assert.equal(compilePort(group("and", {...local, negated: "yes"}))(a), false);
});

test("length criteria exclude unmeasured cables and convert supported units", () => {
  const filter = compile(group("and", {kind: "length", min: null, max: 3}));
  assert.equal(filter(cable, a, b), false);
  assert.equal(filter({...cable, lengthValue: "300", lengthUnit: "cm"}, a, b), true);
  assert.equal(filter({...cable, lengthValue: "120", lengthUnit: "in"}, a, b), false);
  assert.equal(filter({...cable, lengthValue: null, lengthUnit: "m"}, a, b), false);
  assert.equal(filter({...cable, lengthValue: "1", lengthUnit: ""}, a, b), false);
});

test("port filters combine device and installed module metadata on the same interface", () => {
  const choice = id => [{id}];
  const device = {id: 10, deviceTypeId: 20, filter: {
    deviceRoles: choice(31), deviceTags: choice(32), deviceTypeTags: choice(33), deviceManufacturers: choice(34),
  }};
  const port = {kind: "interface", name: "Ethernet3/2/12", device, vlanMode: "tagged", filter: {
    interfaceId: 41, modules: choice(42), moduleTypes: choice(43), moduleTags: choice(44), moduleTypeTags: choice(45),
    moduleManufacturers: choice(46),
  }};
  const hardware = endpoint("any", {
    devices: [7, 10], deviceTypes: [20], deviceRoles: [31], deviceTags: [32], deviceTypeTags: [33],
    deviceManufacturers: [34], interfaces: [41], modules: [42], moduleTypes: [43], moduleTags: [44],
    moduleTypeTags: [45], moduleManufacturers: [46], portRanges: "Ethernet3/2/1-24",
  });
  const mode = {kind: "vlan-mode", endpoint: "any", values: ["tagged", "tagged-all"]};
  const filter = compilePort(group("or", group("and", hardware, mode), endpoint("any", {interfaces: [47]})));

  assert.equal(filter(port), true);
  assert.equal(filter({...port, name: "Ethernet3/3/12"}), false);
  assert.equal(filter({...port, vlanMode: "access"}), false);
  assert.equal(filter({...port, device: {...device, id: 12}}), false);
  assert.equal(filter({...port, filter: {...port.filter, moduleTags: []}}), false);
  assert.equal(filter({name: "mgmt", device, filter: {interfaceId: 47}}), true);
  assert.equal(compilePort(group("and", hardware, mode), {vlan: false})(port), false);
  const unconfigured = compilePort(group("and", {...mode, values: [""]}));
  assert.equal(unconfigured({...port, vlanMode: ""}), true);
  assert.equal(unconfigured({kind: "front-port", vlanMode: ""}), false);
  assert.equal(compilePort(group("and", {kind: "location", scope: "outside-rack", values: []}))(port), false);
  assert.equal(compilePort(empty())(port), true);
  assert.equal(compilePort(null)(port), true);

  const reusable = compilePort(group("and", endpoint("any", {deviceTypeTags: [33], moduleTypes: [43]})));
  assert.equal(reusable({...port, device: {...device, id: 200}, filter: {...port.filter, interfaceId: 400}}), true);
});

test("location conditions distinguish known remote, rackless and unavailable endpoints", () => {
  const at = (rack, site, outsideRack) => ({device: {filter: {
    rack: rack == null ? null : {id: rack}, site: site == null ? null : {id: site}, outsideRack,
  }}});
  const local = at(10, 20, false);
  const sameSite = at(11, 20, true);
  const otherSite = at(12, 21, true);
  const rackless = at(null, 21, true);
  const hiddenRack = at(null, 20, true);
  const noMetadata = {device: {id: 99}};
  const location = (scope, values = []) => ({kind: "location", scope, values});
  const settings = {rackId: 10, siteId: 20};
  const allows = (scope, values) => compile(group("and", location(scope, values)), settings);

  assert.equal(allows("within-rack")(cable, local, local), true);
  assert.equal(allows("within-rack")(cable, local, sameSite), false);
  assert.equal(allows("outside-rack")(cable, sameSite, local), true);
  assert.equal(allows("outside-rack")(cable, local, rackless), true);
  assert.equal(allows("outside-rack")(cable, local, null), false);
  assert.equal(allows("outside-rack")(cable, local, noMetadata), false);
  assert.equal(allows("other-rack")(cable, sameSite, local), true);
  assert.equal(allows("other-rack")(cable, local, rackless), false);
  assert.equal(allows("other-rack")(cable, local, hiddenRack), false);
  assert.equal(allows("other-site")(cable, local, sameSite), false);
  assert.equal(allows("other-site")(cable, local, rackless), true);
  assert.equal(allows("other-site")(cable, local, at(12, null, true)), false);
  assert.equal(allows("selected-racks", [11, 12])(cable, otherSite, local), true);
  assert.equal(allows("selected-racks", [10])(cable, local, local), false);
  assert.equal(allows("selected-sites", [20])(cable, local, sameSite), true);
  assert.equal(allows("selected-sites", [20])(cable, local, rackless), false);

  const mixed = compile(group("or", location("within-rack"), location("selected-sites", [21])), settings);
  assert.equal(mixed(cable, local, local), true);
  assert.equal(mixed(cable, rackless, local), true);
  assert.equal(mixed(cable, sameSite, local), false);
  assert.equal(mixed(cable, local, null), false);
});
