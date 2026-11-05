const assert = require("node:assert/strict");
const {test} = require("node:test");

require("../nbcableeditor/static/nbcableeditor/rack-cable-path.js");

const {anchorPorts, roundPath} = globalThis.NbCableEditorCablePath;
const route = [{x: 0, y: 0}, {x: 50, y: 0}, {x: 50, y: 50}];

test("anchors diagonal routes at the midpoint of the edge they leave", () => {
  const port = {port: "a", left: 10, right: 26, top: 10, bottom: 20};
  const center = {x: 18, y: 15};
  const cases = [
    [{x: 0, y: 20}, {x: 10, y: 15}, "y"],
    [{x: 14, y: 0}, {x: 18, y: 10}, "x"],
    [{x: 40, y: 19}, {x: 26, y: 15}, "y"],
    [{x: 25, y: 40}, {x: 18, y: 20}, "x"],
  ];
  for (const [outside, anchor, crossAxis] of cases) {
    const anchored = anchorPorts([center, outside], port);
    assert.deepEqual(anchored[0], anchor);
    assert.equal(anchored[1][crossAxis], anchor[crossAxis]);
    assert.deepEqual(anchored.at(-1), outside);
  }
});

test("anchors both ends after interior waypoints without changing the middle of the route", () => {
  const a = {port: "a", left: 10, right: 26, top: 10, bottom: 20};
  const b = {port: "b", left: 70, right: 86, top: 50, bottom: 60};
  const points = [{x: 18, y: 15}, {x: 22, y: 17}, {x: 40, y: 28}, {x: 60, y: 31}, {x: 78, y: 55}];
  const anchored = anchorPorts(points, a, b);
  assert.deepEqual(anchored[0], {x: 26, y: 15});
  assert.deepEqual(anchored.at(-1), {x: 78, y: 50});
  assert.ok(anchored.includes(points[2]) && anchored.includes(points[3]));
  assert.deepEqual(roundPath(anchored, [a, b]).points.at(-1), anchored.at(-1));
});

test("uses a sustained approach past a short corner instead of bending beside the port", () => {
  const port = {port: "a", left: 90, right: 110, top: 90, bottom: 110};
  const path = [{x: 100, y: 100}, {x: 112, y: 88}, {x: 112, y: 60}];
  const anchored = anchorPorts(path, port);
  assert.deepEqual(anchored.slice(0, 2), [{x: 100, y: 90}, {x: 100, y: 78}]);
  assert.deepEqual(anchored.at(-1), path.at(-1));

  const neighbor = {port: "neighbor", left: 96, right: 104, top: 69, bottom: 86};
  const cramped = anchorPorts(path, port, undefined, [neighbor]);
  assert.deepEqual(cramped.slice(0, 2), [{x: 110, y: 100}, {x: 111, y: 100}]);
});

test("rounding preserves the straight ten pixels on both sides of a cable corner", () => {
  const path = [{x: 0, y: 0}, {x: 12, y: 0}, {x: 12, y: 12}];
  assert.equal(roundPath(path, [], undefined, true).d, "M 0 0 L 10 0 Q 12 0 12 2 L 12 12");
});

test("moves a shallow loop away from the port row when both leads can be extended", () => {
  const a = {port: "a", left: 0, right: 10, top: 20, bottom: 30};
  const b = {port: "b", left: 30, right: 40, top: 20, bottom: 30};
  const middle = {port: "middle", left: 15, right: 25, top: 20, bottom: 30};
  const points = [{x: 5, y: 25}, {x: 5, y: 14}, {x: 35, y: 14}, {x: 35, y: 25}];
  assert.deepEqual(anchorPorts(points, a, b, [a, b, middle]),
    [{x: 5, y: 20}, {x: 5, y: 8}, {x: 35, y: 8}, {x: 35, y: 20}]);

  const obstacle = {left: 15, right: 25, top: 7, bottom: 11};
  assert.deepEqual(anchorPorts(points, a, b, [a, b, middle, obstacle]),
    [{x: 5, y: 20}, {x: 5, y: 14}, {x: 35, y: 14}, {x: 35, y: 20}]);
});

test("rounds an open corner while preserving exact port endpoints and sampling the same curve", () => {
  const shape = roundPath(route, []);
  assert.equal(shape.d, "M 0 0 L 32 0 Q 50 0 50 18 L 50 50");
  assert.deepEqual(shape.points[0], route[0]);
  assert.deepEqual(shape.points.at(-1), route.at(-1));
  assert.deepEqual(shape.points[5], {x: 45.5, y: 4.5});
});

test("reduces the radius when the rounded path would clip an obstacle", () => {
  const obstacle = {left: 32, right: 47, top: 3, bottom: 20};
  const shape = roundPath(route, [obstacle]);
  assert.match(shape.d, /Q 50 0/);
  assert.ok(shape.points[1].x > 32);
  assert.ok(shape.points.every(({x, y}) => x > obstacle.right || y < obstacle.top));
});

test("keeps a tight corner when no rounded turn has enough clearance", () => {
  const obstacle = {left: 20, right: 49, top: 1, bottom: 24};
  const shape = roundPath(route, [obstacle]);
  assert.equal(shape.d, "M 0 0 L 50 0 L 50 50");
  assert.deepEqual(shape.points, route);
});
