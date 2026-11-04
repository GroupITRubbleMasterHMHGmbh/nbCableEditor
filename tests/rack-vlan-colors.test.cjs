const test = require("node:test");
const assert = require("node:assert/strict");
require("../netbox_rack_editor/static/netbox_rack_editor/rack-vlan-colors.js");

const {rule, restore, fill} = globalThis.NetBoxRackVlanColors;

test("VLAN fill prioritizes the first matching rule over the VLAN's own color and fallback", () => {
  const settings = restore({
    rules: [{ids: "10, 50-70", color: "#16a34a"}, {ids: "60-80", color: "#eab308"}],
    fallback: "#dc2626",
  });
  assert.equal(fill({vid: 60, color: "#FFFFFF"}, settings), "#16A34A");
  assert.equal(fill({vid: 75, color: "#FFFFFF"}, settings), "#EAB308");
  assert.equal(fill({vid: 40, color: "#123456"}, settings), "#123456");
  assert.equal(fill({vid: 40, color: "#xyz"}, settings), "#DC2626");
  assert.equal(fill(null, settings), "");
});

test("invalid VLAN ranges fail validation and corrupted browser settings are ignored", () => {
  for (const ids of ["", "0", "4095", "70-50", "10,,20", "50.5", "10-"]) {
    assert.throws(() => rule(ids, "#123456"), /VLAN IDs/);
  }
  assert.deepEqual(restore({rules: [{ids: "0", color: "#123456"}, {ids: "20", color: "red"}], fallback: "red"}),
    {rules: [], fallback: ""});
});
