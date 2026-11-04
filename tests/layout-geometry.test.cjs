const assert = require("node:assert/strict");
const test = require("node:test");

const {alignPorts, snapPoint} = require("../netbox_rack_editor/static/netbox_rack_editor/layout-geometry.js");

test("aligns one axis while retaining identities, labels and positions on the other axis", () => {
  const points = [{id: 1, label: "A", x: .25, y: .125}, {id: 2, x: .75, y: .625}];
  assert.deepEqual(alignPorts(points, "row"), [
    {id: 1, label: "A", x: .25, y: .375}, {id: 2, x: .75, y: .375},
  ]);
  assert.deepEqual(alignPorts(points, "column"), [
    {id: 1, label: "A", x: .5, y: .125}, {id: 2, x: .5, y: .625},
  ]);
  assert.equal(points[0].x, .25);
  assert.equal(points[0].y, .125);
});

test("lays out irregular selected ports in reading order within their existing bounds", () => {
  const points = [
    {id: "d", x: .875, y: .625}, {id: "a", x: .125, y: .3125}, {id: "c", x: .25, y: .6875},
    {id: "b", x: .75, y: .25}, {id: "e", x: .5, y: .875},
  ];
  assert.deepEqual(alignPorts(points, "grid", 2), [
    {id: "d", x: .875, y: .5625}, {id: "a", x: .125, y: .25}, {id: "c", x: .125, y: .5625},
    {id: "b", x: .875, y: .25}, {id: "e", x: .125, y: .875},
  ]);
});

test("keeps ports individually selectable when aligning two rows into one", () => {
  const points = [{x: .25, y: .2}, {x: .75, y: .2}, {x: .25, y: .8}, {x: .75, y: .8}];
  const row = alignPorts(points, "row");
  assert.equal(new Set(row.map(point => point.x)).size, 4);
  assert.deepEqual(row.map(point => point.y), [.5, .5, .5, .5]);
  const column = alignPorts(points, "column");
  assert.equal(new Set(column.map(point => point.y)).size, 4);
  assert.deepEqual(column.map(point => point.x), [.5, .5, .5, .5]);
});

test("expands a collapsed grid axis just enough to separate rows at the canvas edge", () => {
  const points = [.125, .25, .5, .75].map(x => ({x, y: .95}));
  const result = alignPorts(points, "grid", 2, {x: .05, y: .25});
  assert.deepEqual(result, [
    {x: .125, y: .75}, {x: .75, y: .75}, {x: .125, y: 1}, {x: .75, y: 1},
  ]);
});

test("prioritizes nearby object guides over a square pixel grid on both axes", () => {
  const settings = {width: 1000, height: 100, step: 20, grid: true, objects: true};
  assert.deepEqual(snapPoint({x: .393, y: .28}, {...settings, targets: {x: [.398], y: [.33]}}), {
    x: .398, y: .33, guideX: .398, guideY: .33,
  });
  assert.deepEqual(snapPoint({x: .393, y: .28}, {...settings, targets: {x: [.41], y: [.42]}}), {
    x: .4, y: .2, guideX: null, guideY: null,
  });
});

test("snaps object edges only where they stay in bounds and reports the guide at the aligned edge", () => {
  const settings = {width: 1000, height: 100, objects: true, maxX: .75, anchors: {x: [.25]}};
  assert.deepEqual(snapPoint({x: .75, y: .4}, {...settings, targets: {x: [1.002, .997]}}), {
    x: .747, y: .4, guideX: .997, guideY: null,
  });
  assert.deepEqual(snapPoint({x: .75, y: .4}, {...settings, targets: {x: [1.002]}}), {
    x: .75, y: .4, guideX: null, guideY: null,
  });
});
