const assert = require("node:assert/strict");
const test = require("node:test");

require("../netbox_rack_editor/static/netbox_rack_editor/rack-rows.js");

const {group} = globalThis.NetBoxRackRows;

test("groups uneven port placements into top-down rows and orders each row left to right", () => {
  const ports = [
    {id: 4, face: "front", x: .8, y: .66},
    {id: 2, face: "front", x: .8, y: .29},
    {id: 1, face: "front", x: .1, y: .33},
    {id: 3, face: "front", x: .1, y: .62},
    {id: 5, face: "front", x: null, y: null},
  ];
  const device = {id: 12, position: 3, height: 1, face: "front", fullDepth: false, ports};
  const expected = [
    {id: "12:front:1", deviceId: 12, rackFace: "front", number: 1, ports: [1, 2]},
    {id: "12:front:2", deviceId: 12, rackFace: "front", number: 2, ports: [3, 4]},
  ];
  assert.deepEqual(group({height: 12, devices: [device]}), expected);
  assert.deepEqual(group({height: 12, devices: [{...device, ports: ports.slice().reverse()}]}), expected);
});

test("maps rear-mounted images to their actual rack side and skips unmounted devices", () => {
  const device = {
    id: 20, position: 10.5, height: .5, face: "rear", fullDepth: true,
    ports: [{id: 1, face: "front", x: .2, y: .1}, {id: 2, face: "rear", x: .2, y: .1}],
  };
  assert.deepEqual(group({height: 12, startingUnit: 10, descUnits: true, devices: [
    device, {...device, id: 21, position: null}, {...device, id: 22, position: 22},
  ]}), [
    {id: "20:front:1", deviceId: 20, rackFace: "front", number: 1, ports: [2]},
    {id: "20:rear:1", deviceId: 20, rackFace: "rear", number: 1, ports: [1]},
  ]);
});

test("keeps interface and passive port IDs distinct when they share a numeric ID and placement", () => {
  const ports = ["rear-port:7", "front-port:7", 7, 2].map(id => ({id, face: "front", x: .2, y: .1}));
  const device = {id: 12, position: 3, height: 1, face: "front", fullDepth: false, ports};
  const expected = [{id: "12:front:1", deviceId: 12, rackFace: "front", number: 1,
    ports: [2, 7, "front-port:7", "rear-port:7"]}];
  assert.deepEqual(group({height: 12, devices: [device]}), expected);
  assert.deepEqual(group({height: 12, devices: [{...device, ports: ports.slice().reverse()}]}), expected);
});
