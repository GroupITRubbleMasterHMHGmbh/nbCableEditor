const test = require("node:test");
const assert = require("node:assert/strict");
require("../nbcableeditor/static/nbcableeditor/rack-position-indicator.js");

const {viewportGeometry, scrollForThumb, projectRect, horizontalViewport} = globalThis.NbCableEditorPositionIndicator;

test("shows the visible fraction of the rack at its scroll position", () => {
  const geometry = viewportGeometry(240, 1000, 400, 300);
  assert.deepEqual(geometry, {height: 96, top: 72, range: 600, travel: 144, progress: 0.5});
  assert.equal(scrollForThumb(geometry, geometry.top), 300);
  assert.equal(scrollForThumb(geometry, 36), 150);
});

test("preserves both scroll endpoints with a minimum draggable thumb", () => {
  const top = viewportGeometry(100, 3000, 240, 0);
  const bottom = viewportGeometry(100, 3000, 240, 2760);
  assert.equal(top.height, 14);
  assert.equal(top.top, 0);
  assert.equal(bottom.top + bottom.height, 100);
  assert.equal(scrollForThumb(top, -30), 0);
  assert.equal(scrollForThumb(bottom, 160), 2760);
});

test("a fully visible rack has no scroll range or thumb travel", () => {
  const geometry = viewportGeometry(200, 400, 400, 0);
  assert.deepEqual(geometry, {height: 200, top: 0, range: 0, travel: 0, progress: 0});
  assert.equal(scrollForThumb(geometry, 150), 0);
});

test("projects front and rear devices with their widths, unit heights, and intervening gaps", () => {
  const rack = {left: 50, top: 0, width: 400, height: 800};
  const front = projectRect({left: 50, top: 80, width: 180, height: 80}, rack);
  const rear = projectRect({left: 270, top: 200, width: 180, height: 40}, rack);
  assert.deepEqual(front, {left: 0, top: 0.1, width: 0.45, height: 0.1});
  assert.deepEqual(rear, {left: 0.55, top: 0.25, width: 0.45, height: 0.05});
});

test("the viewport frame follows horizontal panning across the visible rack faces", () => {
  const rack = {left: 50, width: 400};
  assert.deepEqual(horizontalViewport(160, rack, 0, 500), {left: 0, width: 160});
  assert.deepEqual(horizontalViewport(160, rack, 50, 200), {left: 0, width: 80});
  assert.deepEqual(horizontalViewport(160, rack, 250, 200), {left: 80, width: 80});
  assert.deepEqual(horizontalViewport(160, rack, 450, 50), {left: 146, width: 14});
});
