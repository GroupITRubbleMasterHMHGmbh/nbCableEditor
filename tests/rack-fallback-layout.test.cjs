const assert = require("node:assert/strict");
const test = require("node:test");

require("../nbcableeditor/static/nbcableeditor/rack-fallback-layout.js");
require("../nbcableeditor/static/nbcableeditor/rack-rows.js");

const {project} = globalThis.NbCableEditorFallbackLayout;
const {group} = globalThis.NbCableEditorRows;

function port(id) {
  return {
    id, name: "Ethernet1/0/" + id, label: "Physical label " + id,
    face: "front", x: null, y: null, occupancy: "cabled", cableId: 200 + id,
  };
}

function rack(ports, device = {}) {
  return {height: 12, devices: [{
    id: 1, position: 2, height: 1, face: "front", fullDepth: false, missingLayout: true, ports, ...device,
  }]};
}

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, actual + " differs from " + expected);
}

test("projects naturally ordered 24-column rows with the full interface names", () => {
  const ports = Array.from({length: 49}, (_, index) => port(index + 1)).reverse();
  const data = rack(ports);
  const original = structuredClone(data);
  const result = project(data);
  const [device] = result.devices;
  assert.deepEqual(device.ports.map(item => item.id), ports.map(item => item.id));
  assert.deepEqual(data, original);

  const byId = new Map(device.ports.map(item => [item.id, item]));
  const first = byId.get(1);
  const second = byId.get(2);
  const last = byId.get(24);
  const nextRow = byId.get(25);
  const finalRow = byId.get(49);
  assert.deepEqual(group(result).map(row => row.ports.length), [24, 24, 1]);
  assert.deepEqual([first.fallbackRow, last.fallbackRow, nextRow.fallbackRow, finalRow.fallbackRow], [1, 1, 2, 3]);
  assert.deepEqual([first.fallbackLayout, first.name, first.occupancy, first.cableId],
    [true, "Ethernet1/0/1", "cabled", 201]);
  closeTo(last.x - first.x, 23 * (second.x - first.x));
  closeTo(nextRow.x, first.x);
  closeTo(finalRow.x, first.x);
  closeTo(nextRow.y - first.y, finalRow.y - nextRow.y);
  assert.ok(first.y > 0.38 && finalRow.y < 0.96);
});

test("centers a short single row and retains passive cable endpoints", () => {
  const passive = {id: "rear-port:1", name: "Rear panel", face: "rear", x: null, y: null, cableId: 44};
  const data = rack([passive, port(1)]);
  const projected = project(data);
  const [rear, ethernet] = projected.devices[0].ports;
  assert.equal(rear.face, "front");
  assert.equal(rear.name, passive.name);
  assert.equal(rear.cableId, 44);
  assert.deepEqual(group(projected).map(row => row.ports), [[1, "rear-port:1"]]);
  closeTo((rear.x + ethernet.x) / 2, 0.5);
  closeTo(rear.y, ethernet.y);
});

test("keeps rear ports on the rear image of full-depth devices mounted on either side", () => {
  const rear = {id: "rear-port:1", name: "Rear panel", face: "rear", x: null, y: null};
  const projected = project(rack([port(1), rear], {face: "rear", fullDepth: true}));
  assert.deepEqual(group(projected).map(({rackFace, ports}) => [rackFace, ports]),
    [["front", ["rear-port:1"]], ["rear", [1]]]);
});

test("keeps dense fallback rows separate in a short device", () => {
  const ports = Array.from({length: 193}, (_, index) => port(index + 1));
  const rows = group(project(rack(ports)));
  assert.deepEqual(rows.map(row => row.ports.length), [24, 24, 24, 24, 24, 24, 24, 24, 1]);
});

test("leaves saved and unavailable layouts unchanged, including unplaced ports", () => {
  const data = rack([{...port(1), x: 0.2, y: 0.4}, port(2)], {missingLayout: false});
  const unknown = {...data.devices[0], missingLayout: null};
  data.devices.push(unknown);
  const result = project(data);
  assert.equal(result.devices[0], data.devices[0]);
  assert.equal(result.devices[1], unknown);
  assert.equal(result.devices[0].ports[1].x, null);
});
