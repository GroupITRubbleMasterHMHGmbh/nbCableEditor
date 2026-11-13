const test = require("node:test");
const assert = require("node:assert/strict");
require("../nbcableeditor/static/nbcableeditor/rack-compact-units.js");
require("../nbcableeditor/static/nbcableeditor/rack-position-indicator.js");

const {layoutRows, verticalAxis} = globalThis.NbCableEditorCompactUnits;
const {viewportGeometry, scrollForAxis} = globalThis.NbCableEditorPositionIndicator;

test("compacts only runs of more than two empty units, retaining partially occupied units", () => {
  const devices = [{top: 2.5, height: 1}, {top: 10, height: 1}, {top: 12, height: 1}];
  const {rows, rowCount} = layoutRows(17, devices, {compact: true});
  assert.equal(rowCount, 11);
  assert.deepEqual(rows.filter(row => row.end - row.start > 1), [
    {start: 4, end: 10, top: 4, size: 2},
    {start: 13, end: 17, top: 9, size: 2},
  ]);
  assert.equal(rows.find(row => row.start === 10).top, 6);
  assert.equal(rows.find(row => row.start === 3).size, 1);
  assert.equal(layoutRows(17, devices).rowCount, 17);
});

test("a device-focused view retains its existing projection", () => {
  assert.deepEqual(layoutRows(15, [{top: 4, height: 1}, {top: 11.5, height: 1}], {focused: true, compact: true}), {
    rowCount: 3,
    rows: [
      {start: 4, end: 5, top: 0, size: 1},
      {start: 11, end: 12, top: 1, size: 1},
      {start: 12, end: 13, top: 2, size: 1},
    ],
  });
});

test("maps displayed and physical distances reversibly across multiple compressed bands", () => {
  const axis = verticalAxis([
    {top: 100, height: 80, count: 8},
    {top: 240, height: 80, count: 5},
  ], 400);
  assert.equal(axis.height, 760);
  assert.deepEqual([40, 100, 140, 180, 240, 280, 320, 400].map(axis.toPhysical),
    [40, 100, 260, 420, 480, 580, 680, 760]);
  for (const value of [0, 50, 100, 125, 180, 200, 240, 295, 320, 400]) {
    assert.equal(axis.toDisplayed(axis.toPhysical(value)), value);
  }
});

test("the miniature viewport shows and drags across a collapsed band on the full physical scale", () => {
  const axis = verticalAxis([{top: 100, height: 80, count: 8}], 400);
  const trackHeight = 320;
  const viewport = viewportGeometry(trackHeight, 400, 80, 120, axis);
  assert.equal(viewport.top, 90);
  assert.equal(viewport.height, 130);
  assert.equal(scrollForAxis(axis, trackHeight, 80, 130, 0.25), 120);
  assert.equal(scrollForAxis(axis, trackHeight, 80, 320, 0.5), 320);
});
