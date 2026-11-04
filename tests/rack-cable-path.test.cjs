const assert = require("node:assert/strict");
const {test} = require("node:test");

require("../netbox_rack_editor/static/netbox_rack_editor/rack-cable-path.js");

const {roundPath} = globalThis.NetBoxRackCablePath;
const route = [{x: 0, y: 0}, {x: 50, y: 0}, {x: 50, y: 50}];

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
