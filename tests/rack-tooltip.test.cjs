const assert = require("node:assert/strict");
const {test} = require("node:test");

require("../nbcableeditor/static/nbcableeditor/rack-tooltip.js");

const {visibleSegments, nearestPoint, place} = globalThis.NbCableEditorTooltip;
const point = (x, y) => ({x, y});

test("only the visible route participates in pointer projection", () => {
  const clip = {left: 10, top: 10, right: 30, bottom: 30};
  const route = [point(-10, 20), point(20, 20), point(20, 40), point(40, 40)];
  const segments = visibleSegments(route, clip);
  assert.deepEqual(segments, [
    {a: point(10, 20), b: point(20, 20)},
    {a: point(20, 20), b: point(20, 30)},
  ]);
  assert.deepEqual(nearestPoint(segments, point(9, 24)), point(10, 20));
  assert.deepEqual(nearestPoint(segments, point(28, 28)), point(20, 28));
  assert.equal(nearestPoint([], point(0, 0)), null);
});

test("placement stays clear of every leg of a folded route", () => {
  const bounds = {left: 4, top: 4, right: 346, bottom: 250};
  const route = [point(0, 67), point(300, 67), point(300, 117), point(80, 117), point(80, 166), point(350, 166)];
  const segments = visibleSegments(route, bounds);
  const anchor = point(155, 117);
  const width = 112;
  const height = 52;
  const result = place({anchor, width, height, bounds, segments});
  assert.ok(result);
  const {left, top, edge} = result;
  const right = left + width;
  const bottom = top + height;
  assert.ok(left >= bounds.left && top >= bounds.top && right <= bounds.right && bottom <= bounds.bottom);
  assert.ok(edge.x === left || edge.x === right || edge.y === top || edge.y === bottom);
  assert.ok(edge.x >= left && edge.x <= right && edge.y >= top && edge.y <= bottom);

  // All legs in this fixture are axis-aligned, so their extents give an exact check.
  const clearance = 24;
  for (const {a, b} of segments) {
    assert.ok(Math.max(a.x, b.x) < left - clearance || Math.min(a.x, b.x) > right + clearance ||
      Math.max(a.y, b.y) < top - clearance || Math.min(a.y, b.y) > bottom + clearance);
  }
});

test("small pointer movements can retain a prior clear position and update the connector", () => {
  const bounds = {left: 0, top: 0, right: 500, bottom: 300};
  const segments = visibleSegments([point(30, 150), point(470, 150)], bounds);
  const layout = {width: 130, height: 58, bounds, segments};
  const first = place({...layout, anchor: point(245, 150)});
  const second = place({...layout, anchor: point(252, 150), previous: first});
  assert.equal(first.left, second.left);
  assert.equal(first.top, second.top);
  assert.equal(second.edge.x, 252);
});

test("placement returns null if there is no clear viewport space", () => {
  const bounds = {left: 0, top: 0, right: 120, bottom: 80};
  const anchor = point(60, 40);
  const segments = visibleSegments([point(0, 40), point(120, 40)], bounds);
  assert.equal(place({anchor, width: 100, height: 62, bounds, segments}), null);
  assert.equal(place({anchor, width: 121, height: 30, bounds, segments: []}), null);
});
