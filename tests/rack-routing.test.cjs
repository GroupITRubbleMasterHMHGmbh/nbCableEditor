const assert = require("node:assert/strict");
const {test} = require("node:test");

require("../netbox_rack_editor/static/netbox_rack_editor/rack-routing.js");
require("../netbox_rack_editor/static/netbox_rack_editor/rack-corridors.js");

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

function sharedTrackLength(routes) {
  const segments = [...routes.values()].flatMap((points, route) => points.slice(1).map((b, i) => ({
    a: points[i], b, route,
  })));
  let shared = 0;
  for (const [i, first] of segments.entries()) {
    const {a, b} = first;
    const axis = a.x === b.x ? "y" : a.y === b.y ? "x" : null;
    if (axis === null) continue;
    const fixed = axis === "x" ? "y" : "x";
    const low = Math.min(a[axis], b[axis]);
    const high = Math.max(a[axis], b[axis]);
    for (let j = 0; j < i; j++) {
      const second = segments[j];
      if (second.route === first.route || second.a[fixed] !== a[fixed] || second.b[fixed] !== a[fixed]) continue;
      shared += Math.max(0, Math.min(high, Math.max(second.a[axis], second.b[axis])) -
        Math.max(low, Math.min(second.a[axis], second.b[axis])));
    }
  }
  return shared;
}

function pcbFixture(interveningCard) {
  const bounds = {width: 660, height: 260};
  const obstacles = [
    {id: "A", left: 80, top: 25, right: 580, bottom: 69},
    {id: "B", left: 80, top: interveningCard ? 156 : 95, right: 580, bottom: interveningCard ? 200 : 139},
  ];
  if (interveningCard) obstacles.push({id: "C", left: 80, top: 89, right: 580, bottom: 137});
  const protectedAreas = [];
  function port(card, index) {
    const x = card.left + 23 + (index % 24) * 19.5;
    const y = card.top + 13 + Math.floor(index / 24) * 18;
    const port = card.id + index;
    protectedAreas.push(
      {port, kind: "port", left: x - 5.75, top: y - 5.75, right: x + 5.75, bottom: y + 5.75},
      {port, kind: "label", left: x - 6.5, top: y - 15, right: x + 6.5, bottom: y - 7},
    );
    return {x, y, port, device: card.id};
  }
  const permutation = Array.from({length: 48}, (_, i) => i);
  let seed = 10;
  for (let i = permutation.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
  }
  const connections = permutation.map((to, id) => ({id, a: port(obstacles[0], id), b: port(obstacles[1], to)}));
  return {bounds, obstacles, protectedAreas, connections};
}

function assertPcbPaths(routes, {bounds, obstacles, protectedAreas, connections}) {
  assert.equal(routes.size, connections.length);
  for (const {id, a, b} of connections) {
    const points = routes.get(id);
    assert.deepEqual(points[0], {x: a.x, y: a.y});
    assert.deepEqual(points.at(-1), {x: b.x, y: b.y});
    assert.ok(points.every(({x, y}) => x >= 0 && x <= bounds.width && y >= 0 && y <= bounds.height));
    for (const card of obstacles) {
      if (card.id !== a.device && card.id !== b.device) assertOutsideArea(points, card);
    }
    for (const area of protectedAreas) {
      if (area.kind === "port" && area.port === a.port) assertOutsideArea(points.slice(1), area);
      else if (area.kind === "port" && area.port === b.port) assertOutsideArea(points.slice(0, -1), area);
      else assertOutsideArea(points, area);
    }
  }
}

test("PCB tracks separate dense arbitrary 48-port wiring and preserve the balanced default", () => {
  const fixture = pcbFixture(false);
  const {bounds, obstacles, protectedAreas, connections} = fixture;
  const balanced = routeCables(connections, obstacles, bounds, protectedAreas);
  assert.deepEqual(balanced, routeCables(connections, obstacles, bounds, protectedAreas, {strategy: "balanced"}));
  const pcb = routeCables(connections, obstacles, bounds, protectedAreas, {strategy: "pcb"});
  assert.deepEqual(pcb, routeCables([...connections].reverse(), [...obstacles].reverse(), bounds,
    [...protectedAreas].reverse(), {strategy: "pcb"}));
  assertPcbPaths(pcb, fixture);
  assert.ok(crossingCount(pcb) < crossingCount(balanced) * .75);
  assert.ok(sharedTrackLength(pcb) < sharedTrackLength(balanced) * .25);
});

test("PCB keeps a dense bundle off intervening equipment using both sides", () => {
  const fixture = pcbFixture(true);
  const {bounds, obstacles, protectedAreas, connections} = fixture;
  const routes = routeCables(connections, obstacles, bounds, protectedAreas, {strategy: "pcb"});
  assertPcbPaths(routes, fixture);
  const card = obstacles[2];
  const paths = [...routes.values()];
  assert.ok(paths.some(points => points.some(({x}) => x < card.left)));
  assert.ok(paths.some(points => points.some(({x}) => x > card.right)));
  assert.ok(sharedTrackLength(routes) < 4_000);
});

test("PCB bypasses a horizontal barrier using the only open route above or below it", () => {
  const a = {x: 38, y: 86, device: "A"};
  const b = {x: 282, y: 91, device: "B"};
  const equipment = [
    {id: "A", left: 24, top: 49, right: 57, bottom: 132},
    {id: "B", left: 263, top: 43, right: 298, bottom: 131},
  ];
  const bounds = {width: 320, height: 180};
  for (const [top, bottom, outside] of [[25, 180, ({y}) => y < 25], [0, 153, ({y}) => y > 153]]) {
    const card = {id: "C", left: 82, top, right: 242, bottom};
    const [points] = routeCables([{id: 1, a, b}], [...equipment, card], bounds, [], {strategy: "pcb"}).values();
    assertOutsideArea(points, card);
    assert.ok(points.some(outside));
  }
});

test("PCB can leave an upper port towards the space above its card past a wide label", () => {
  const bounds = {width: 320, height: 300};
  const a = {x: 160, y: 72, device: "A", port: 1};
  const b = {x: 180, y: 220, device: "B", port: 2};
  const obstacles = [
    {id: "A", left: 50, top: 60, right: 270, bottom: 100},
    {id: "B", left: 50, top: 194, right: 270, bottom: 236},
    {id: "panel", left: 50, top: 112, right: 270, bottom: 180},
  ];
  const protectedAreas = [
    {port: 1, kind: "port", left: 154.25, top: 66.25, right: 165.75, bottom: 77.75},
    {port: 1, kind: "label", left: 153.5, top: 54, right: 166.5, bottom: 66.5},
    {port: 3, kind: "label", left: 144, top: 54, right: 153.3, bottom: 98},
    {port: 4, kind: "label", left: 167.1, top: 54, right: 176, bottom: 98},
    {port: 5, kind: "port", left: 153.3, top: 79, right: 167.1, bottom: 98},
  ];
  const connections = [{id: 1, a, b}];
  const routes = routeCables(connections, obstacles, bounds, protectedAreas, {strategy: "pcb"});
  assertPcbPaths(routes, {bounds, obstacles, protectedAreas, connections});
  const points = routes.get(1);
  assert.ok(points[1].y < a.y);
  assert.ok(points.some(({y}) => y < obstacles[0].top));
});
