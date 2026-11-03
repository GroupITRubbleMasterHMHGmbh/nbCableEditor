const assert = require("node:assert/strict");
const {test} = require("node:test");

require("../netbox_rack_editor/static/netbox_rack_editor/rack-routing.js");

const {routeCables} = globalThis.NetBoxRackRouting;

function pathLength(routes) {
  let length = 0;
  for (const points of routes.values()) {
    for (let i = 1; i < points.length; i++) {
      length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
  }
  return length;
}

function side(a, b, p) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

function crossingCount(routes) {
  let count = 0;
  const paths = Array.from(routes.values());
  for (let i = 0; i < paths.length; i++) {
    for (let j = 0; j < i; j++) {
      const first = paths[i];
      const second = paths[j];
      for (let p = 1; p < first.length; p++) {
        const [a, b] = [first[p - 1], first[p]];
        for (let q = 1; q < second.length; q++) {
          const [c, d] = [second[q - 1], second[q]];
          if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) count++;
        }
      }
    }
  }
  return count;
}

test("an unobstructed connection uses its exact endpoints without a detour", () => {
  const cable = {id: 1, a: {x: 28, y: 21, device: "A"}, b: {x: 62, y: 68, device: "B"}};
  const result = routeCables([cable], [], {width: 100, height: 100});
  assert.deepEqual(result.get(1), [{x: 28, y: 21}, {x: 62, y: 68}]);
});

test("a short local detour avoids an unrelated card when there is room", () => {
  const bounds = {width: 200, height: 100};
  const a = {x: 15, y: 50, device: "A"};
  const b = {x: 185, y: 50, device: "B"};
  const card = {id: "C", left: 70, top: 40, right: 130, bottom: 60};
  const routes = routeCables([{id: 1, a, b}], [card], bounds);
  const points = routes.get(1);

  assert.ok(pathLength(routes) < 200);
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    for (let sample = 0; sample <= 20; sample++) {
      const x = p.x + (q.x - p.x) * sample / 20;
      const y = p.y + (q.y - p.y) * sample / 20;
      assert.ok(x <= card.left || x >= card.right || y <= card.top || y >= card.bottom);
    }
  }
});

test("48 scrambled patch leads stay in bounds with fewer crossings and less travel", () => {
  const bounds = {width: 1160, height: 780};
  const cards = [
    {id: "A", left: 40, top: 30, right: 510, bottom: 74},
    {id: "B", left: 40, top: 148, right: 510, bottom: 192},
  ];
  const port = (card, index) => ({
    x: card.left + 16 + (index % 24) * 18,
    y: card.top + 13 + Math.floor(index / 24) * 18,
    device: card.id,
  });
  const cables = Array.from({length: 48}, (_, id) => ({
    id,
    a: port(cards[0], id),
    b: port(cards[1], (id * 13 + 17) % 48),
  }));

  const straight = new Map(cables.map(({id, a, b}) => [id, [a, b]]));
  const gutter = new Map(cables.map(({id, a, b}) => [id, [a, {x: 580, y: a.y}, {x: 580, y: b.y}, b]]));
  const optimized = routeCables(cables, cards, bounds);
  assert.deepEqual(optimized, routeCables([...cables].reverse(), [...cards].reverse(), bounds));
  assert.ok(crossingCount(optimized) < crossingCount(straight) * .85);
  assert.ok(pathLength(optimized) < pathLength(gutter) * .5);
  for (const {id, a, b} of cables) {
    const points = optimized.get(id);
    assert.deepEqual(points[0], {x: a.x, y: a.y});
    assert.deepEqual(points.at(-1), {x: b.x, y: b.y});
    assert.ok(points.every(({x, y}) => x >= 0 && x <= bounds.width && y >= 0 && y <= bounds.height));
  }
});


function assertOutsideArea(points, area) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2);
    for (let step = 0; step <= steps; step++) {
      const x = a.x + (b.x - a.x) * step / steps;
      const y = a.y + (b.y - a.y) * step / steps;
      assert.ok(x <= area.left + 1e-7 || x >= area.right - 1e-7 ||
        y <= area.top + 1e-7 || y >= area.bottom - 1e-7, "path crosses protected port " + area.port);
    }
  }
}

test("protected markers and labels outrank a short direct cable path", () => {
  const bounds = {width: 240, height: 180};
  const a = {x: 23, y: 74, port: 1, device: "A"};
  const b = {x: 203, y: 74, port: 2, device: "B"};
  const ownStart = {port: 1, kind: "port", left: 17, top: 68, right: 29, bottom: 80};
  const ownEnd = {port: 2, kind: "port", left: 197, top: 68, right: 209, bottom: 80};
  const labelAtStart = {port: 1, kind: "label", left: 29, top: 65, right: 61, bottom: 82};
  const foreignMarker = {port: 3, kind: "port", left: 91, top: 67, right: 105, bottom: 81};
  const foreignLabel = {port: 4, kind: "label", left: 139, top: 64, right: 171, bottom: 83};
  const protectedAreas = [ownStart, ownEnd, labelAtStart, foreignMarker, foreignLabel];
  const routes = routeCables([{id: 1, a, b}], [], bounds, protectedAreas);
  const points = routes.get(1);

  assert.deepEqual(points[0], {x: a.x, y: a.y});
  assert.deepEqual(points.at(-1), {x: b.x, y: b.y});
  for (const area of [labelAtStart, foreignMarker, foreignLabel]) assertOutsideArea(points, area);
  assertOutsideArea(points.slice(1), ownStart);
  assertOutsideArea(points.slice(0, -1), ownEnd);
});

test("the corridor fallback validates endpoint exemption and wins with the only clear path", () => {
  const bounds = {width: 260, height: 210};
  const a = {x: 130, y: 20, port: 1, device: "A"};
  const b = {x: 130, y: 190, port: 2, device: "B"};
  const ownStart = {port: 1, kind: "port", left: 125, top: 15, right: 135, bottom: 25};
  const foreign = {port: 3, kind: "port", left: 4, top: 100, right: 260, bottom: 110};
  const connection = {id: 1, a, b};
  const areas = [ownStart, foreign];
  let calls = 0;
  const previous = globalThis.NetBoxRackCorridors;
  globalThis.NetBoxRackCorridors = {
    candidates(received, protectedAreas, board, clearSegment) {
      calls++;
      assert.equal(received, connection);
      assert.ok(areas.every((area) => protectedAreas.includes(area)));
      assert.equal(board, bounds);
      assert.equal(clearSegment(a, {x: 130, y: 40}), true);
      assert.equal(clearSegment({x: 130, y: 40}, a), true);
      assert.equal(clearSegment({x: 130, y: 14}, {x: 130, y: 27}), false);
      assert.equal(clearSegment(a, b), false);
      return [[a, {x: 1, y: 96}, {x: 1, y: 114}, b]];
    },
  };
  try {
    const result = routeCables([connection], [], bounds, areas);
    assert.equal(calls, 1);
    assertOutsideArea(result.get(1), foreign);
  } finally {
    globalThis.NetBoxRackCorridors = previous;
  }
});
