const assert = require("node:assert/strict");
const test = require("node:test");

require("../nbcableeditor/static/nbcableeditor/rack-virtual-combine.js");
require("../nbcableeditor/static/nbcableeditor/rack-cable-path.js");
require("../nbcableeditor/static/nbcableeditor/rack-corridors.js");
require("../nbcableeditor/static/nbcableeditor/rack-routing.js");

const {findRuns, planTubes} = globalThis.NbCableEditorVirtualCombine;
const {roundPath} = globalThis.NbCableEditorCablePath;
const {routeCables} = globalThis.NbCableEditorRouting;
const cable = (id, a, b) => ({id, a: {port: a}, b: {port: b}});

test("combines only consecutive ports from the same two rows in matching order", () => {
  const rows = [
    {id: "a:front:1", ports: [1, 2, 3, 4, 5, 6, 7, 8, 9]},
    {id: "b:front:1", ports: [11, 12, 13, 14, 15, 16, 17, 18, 19]},
    {id: "b:front:2", ports: [21, 22]},
  ];
  const cables = [
    cable("h", 9, 19), cable("a", 1, 11), cable("b", 12, 2), cable("c", 3, 21),
    cable("d", 4, 14), cable("e", 6, 16), cable("f", 7, 18), cable("g", 8, 17),
  ];
  assert.deepEqual(findRuns(cables, rows), [{ids: ["a", "b"]}]);
  assert.deepEqual(findRuns([...cables, cable("duplicate", 2, 22)], rows), []);
});

test("intervening physical ports split a run even when the missing cable is filtered out", () => {
  const rows = [
    {id: "a", ports: [1, 2, 3, 4, 5]},
    {id: "b", ports: [11, 12, 13, 14, 15]},
  ];
  assert.deepEqual(findRuns([
    cable(4, 15, 5), cable(3, 4, 14), cable(2, 12, 2), cable(1, 1, 11),
  ], rows), [{ids: [1, 2]}, {ids: [3, 4]}]);
});

test("excludes loopbacks on the same physical device, even across two faces", () => {
  const rows = [
    {id: "a:front:1", deviceId: 1, ports: [1, 2, 3, 4]},
    {id: "a:rear:1", deviceId: 1, ports: [11, 12]},
  ];
  assert.deepEqual(findRuns([cable(1, 1, 11), cable(2, 2, 12)], rows), []);
  assert.deepEqual(findRuns([cable(1, 1, 3), cable(2, 2, 4)], rows), []);
});

function fixture({count = 8, panel = false, extraGap = 0} = {}) {
  const wide = count > 12;
  const right = wide ? 560 : 292;
  const rows = [
    {id: "a:1", deviceId: 1, ports: []},
    {id: "b:1", deviceId: 2, ports: []},
  ];
  const obstacles = [
    {id: "a", left: 54, right, top: 70, bottom: 110},
    {id: "b", left: 54, right, top: 215 + extraGap, bottom: 255 + extraGap},
  ];
  if (panel) obstacles.push({id: "p", left: 54, right, top: 146, bottom: 175});
  const bounds = {width: right + 54, height: 300 + extraGap};
  const connections = [];
  const routes = new Map();
  const protectedAreas = [];
  for (let i = 0; i < count; i++) {
    const x = 112 + i * (wide ? 415 / (count - 1) : 16);
    const upper = {port: i + 1, device: "a", x, y: panel ? 80 : 100};
    const lower = {port: i + (wide ? 101 : 21), device: "b", x: x + 2, y: 225 + extraGap};
    rows[0].ports.push(upper.port);
    rows[1].ports.push(lower.port);
    for (const {port, x, y} of [upper, lower]) {
      protectedAreas.push({port, left: x - 5, right: x + 5, top: y - 4, bottom: y + 4});
    }
    if (panel) protectedAreas.push({port: 50 + i, left: x - 5, right: x + 5, top: 96, bottom: 104});
    const [a, b] = i % 2 ? [lower, upper] : [upper, lower];
    connections.push({id: i, a, b});
    const ordinaryX = i % 2 ? 20 : bounds.width - 26;
    routes.set(i, [a, {x: ordinaryX, y: a.y}, {x: ordinaryX, y: b.y}, b]);
  }
  return {connections, rows, routes, options: {obstacles, protectedAreas, bounds}};
}

function assertCompactTube(plan, connections) {
  assert.equal(plan.tubes.length, 1);
  assert.equal(plan.paths.size, connections.length);
  const [tube] = plan.tubes;
  assert.deepEqual(tube.ids, connections.map(cable => cable.id));
  assert.ok(tube.width >= 10 && tube.width <= 14);
  assert.ok(tube.bottom > tube.top + 15);
  const lanes = new Set();
  for (const {id, a, b} of connections) {
    const points = plan.paths.get(id);
    assert.deepEqual(points[0], a);
    assert.deepEqual(points.at(-1), b);
    for (const y of [tube.top, tube.bottom]) {
      const crossings = points.slice(1).flatMap((to, index) => {
        const from = points[index];
        if ((to.y - y) * (from.y - y) >= 0) return [];
        return [from.x + (to.x - from.x) * (y - from.y) / (to.y - from.y)];
      });
      const x = crossings.find(x => Math.abs(x - tube.x) < tube.width / 2);
      assert.ok(x !== undefined);
      if (y === tube.top) lanes.add(x);
    }
  }
  assert.equal(lanes.size, connections.length);
  return tube;
}

function crossing(a, b, c, d) {
  const ax = b.x - a.x;
  const ay = b.y - a.y;
  const bx = d.x - c.x;
  const by = d.y - c.y;
  const determinant = ax * by - ay * bx;
  if (!determinant) return null;
  const dx = c.x - a.x;
  const dy = c.y - a.y;
  const first = (dx * by - dy * bx) / determinant;
  const second = (dx * ay - dy * ax) / determinant;
  if (first <= 0 || first >= 1 || second <= 0 || second >= 1) return null;
  return {x: a.x + ax * first, y: a.y + ay * first};
}

function crossings(paths) {
  const result = [];
  const entries = [...paths.values()];
  for (const [i, a] of entries.entries()) {
    for (const b of entries.slice(i + 1)) {
      for (let j = 1; j < a.length; j++) {
        for (let k = 1; k < b.length; k++) {
          const point = crossing(a[j - 1], a[j], b[k - 1], b[k]);
          if (point) result.push(point);
        }
      }
    }
  }
  return result;
}

test("compacts the complete eight-cable run into one narrow tube in the facing gap", () => {
  const {connections, rows, routes, options} = fixture();
  const tube = assertCompactTube(planTubes(connections, rows, routes, options), connections);
  assert.ok(tube.x > 120 && tube.x < 218);
  assert.ok(tube.top >= 110 && tube.bottom <= 215);
});

test("roomy fans keep 25 pixels to their device and 8.5 pixels between branch levels", () => {
  const {connections, rows, routes, options} = fixture({extraGap: 90});
  for (const deviceClearance of [undefined, 27]) {
    const plan = planTubes(connections, rows, routes, {...options, deviceClearance});
    assertCompactTube(plan, connections);
    const gaps = [new Set(), new Set()];
    for (const path of plan.paths.values()) {
      const points = path[0].device === "a" ? path : path.slice().reverse();
      const horizontal = points.slice(1).filter((point, i) => point.y === points[i].y);
      assert.equal(horizontal.length, 2);
      gaps[0].add(horizontal[0].y - options.obstacles[0].bottom);
      gaps[1].add(options.obstacles[1].top - horizontal[1].y);
    }
    for (const group of gaps) {
      const levels = [...group].sort((a, b) => a - b);
      assert.ok(levels.length >= 3);
      assert.equal(levels[0], deviceClearance ?? 25);
      assert.ok(levels.slice(1).every((level, i) => level - levels[i] === 8.5));
    }
  }
});

test("keeps longer eligible runs within the same narrow tube width", () => {
  const {connections, rows, routes, options} = fixture({count: 12});
  const plan = planTubes(connections, rows, routes, options);
  const tube = assertCompactTube(plan, connections);
  assert.equal(tube.width, 13);
});

test("keeps 12, 24 and 48 ordered cables in one slim sleeve even in a 64px facing gap", () => {
  for (const count of [12, 24, 48]) {
    const {connections, rows, routes, options} = fixture({count, extraGap: -41});
    for (const area of options.protectedAreas) {
      area.left += 1;
      area.right -= 1;
    }
    const plan = planTubes(connections, rows, routes, {...options, deviceClearance: 27.5});
    const tube = assertCompactTube(plan, connections);
    assert.equal(tube.width, 13);
    assert.ok(tube.top >= options.obstacles[0].bottom && tube.bottom <= options.obstacles[1].top);
    assert.deepEqual(crossings(plan.paths), [], "the facing taper keeps the order of all cables");
  }
});

test("uses the available gap for a longer sleeve in a 48-cable row", () => {
  const {connections, rows, routes, options} = fixture({count: 48, extraGap: 50});
  const tube = assertCompactTube(planTubes(connections, rows, routes, {...options, deviceClearance: 27.5}), connections);
  assert.ok(tube.bottom - tube.top >= 60);
});

test("keeps both 24-port rows bundled with ordinary routes from the other row present", () => {
  const {connections, rows, options} = fixture({count: 48, extraGap: -40});
  const [upper, lower] = options.obstacles;
  const areas = new Map(options.protectedAreas.map(area => [area.port, area]));
  for (const {id, a, b} of connections) {
    const row = Math.floor(id / 24);
    for (const port of [a, b]) {
      const card = port.device === upper.id ? upper : lower;
      port.x = 112 + (id % 24) * 16;
      port.y = card.top + 10 + row * 20;
      Object.assign(areas.get(port.port), {
        left: port.x - 3.5, right: port.x + 3.5, top: port.y - 5, bottom: port.y + 5,
      });
    }
  }
  const banks = rows.flatMap(row => [0, 24].map(offset => ({
    ...row, id: row.id + ":" + offset, ports: row.ports.slice(offset, offset + 24),
  })));
  const routeOptions = {...options, deviceClearance: 27.5, spacing: 9, horizontalSpacing: 14, foreignStrokeWidth: 8};
  const routes = routeCables(connections, options.obstacles, options.bounds, options.protectedAreas, routeOptions);
  const plan = planTubes(connections, banks, routes, routeOptions);
  assert.equal(plan.paths.size, 48);
  assert.deepEqual(plan.tubes.map(tube => tube.ids), [0, 24].map(offset =>
    connections.slice(offset, offset + 24).map(cable => cable.id)));
  assert.ok(plan.tubes.every(tube => tube.width === 13));
});

test("combines upper rows around the outside of an intervening device", () => {
  const {connections, rows, routes, options} = fixture({panel: true});
  const plan = planTubes(connections, rows, routes, {...options, deviceClearance: 10});
  const tube = assertCompactTube(plan, connections);
  assert.ok(tube.x + tube.width / 2 <= 44 || tube.x - tube.width / 2 >= 302);
  assert.ok(tube.top < 70);
  assert.ok(tube.bottom > 175);
  const intersections = crossings(plan.paths);
  assert.equal(intersections.length, 28);
  for (const {x, y} of intersections) {
    assert.ok(Math.abs(x - tube.x) < tube.width / 2 && y > tube.top && y < tube.bottom);
  }
});

test("extends the safe vertical tube into free space above and below the devices", () => {
  const {connections, rows, routes, options} = fixture({panel: true});
  options.bounds.height += 200;
  for (const rect of [...options.obstacles, ...options.protectedAreas]) {
    const offset = rect.port >= 21 && rect.port <= 28 ? 120 : 100;
    rect.top += offset;
    rect.bottom += offset;
  }
  for (const cable of connections) {
    for (const port of [cable.a, cable.b]) port.y += port.device === "b" ? 120 : 100;
  }
  const tube = assertCompactTube(planTubes(connections, rows, routes, options), connections);
  const [upper, lower] = options.obstacles;
  assert.ok(tube.top <= upper.top - 23);
  assert.ok(tube.bottom >= lower.bottom + 23);
  assert.ok(tube.bottom - tube.top >= lower.bottom - upper.top + 75);
});

test("leaves 15 pixels beyond the painted edges around a foreign crossing and ignores runs of two", () => {
  const {connections, rows, routes, options} = fixture();
  const foreignRoutes = new Map(routes);
  foreignRoutes.set(99, [{x: 0, y: 160}, {x: 346, y: 160}]);
  const tube = assertCompactTube(planTubes(connections, rows, routes, {
    ...options, foreignRoutes, foreignStrokeWidth: 4,
  }), connections);
  const clearance = 15 + 2 + 1;
  assert.ok(tube.bottom <= 160 - clearance || tube.top >= 160 + clearance);
  const pair = fixture({count: 2});
  assert.deepEqual(planTubes(pair.connections, pair.rows, pair.routes, pair.options), {paths: new Map(), tubes: []});
});

test("moves a tube away from a parallel foreign cable", () => {
  const {connections, rows, routes, options} = fixture();
  const foreignX = 174;
  routes.set(99, [{x: foreignX, y: 0}, {x: foreignX, y: 300}]);
  const tube = assertCompactTube(planTubes(connections, rows, routes, {...options, foreignStrokeWidth: 4}), connections);
  assert.equal(tube.parallelGap, 25);
  assert.ok(Math.abs(tube.x - foreignX) - tube.width / 2 >= 25 + 2 + 1);
});

test("custom tube settings increase the painted clearance at caps and parallel sides", () => {
  const {connections, rows, routes, options} = fixture();
  const foreignRoutes = new Map(routes);
  const custom = {...options, foreignRoutes, foreignStrokeWidth: 4, tubeGap: 21, tubeParallelGap: 34};
  foreignRoutes.set(99, [{x: 0, y: 160}, {x: 346, y: 160}]);
  const crossing = assertCompactTube(planTubes(connections, rows, routes, custom), connections);
  assert.ok(crossing.bottom <= 160 - 24 || crossing.top >= 160 + 24);

  foreignRoutes.set(99, [{x: 174, y: 0}, {x: 174, y: 300}]);
  const parallel = assertCompactTube(planTubes(connections, rows, routes, custom), connections);
  assert.equal(parallel.parallelGap, 34);
  assert.ok(Math.abs(parallel.x - 174) - parallel.width / 2 >= 37);
});

function horizontalFixture(sideBySide = true) {
  const {connections, rows, routes, options} = fixture();
  const [left, right] = options.obstacles;
  const shift = 280;
  options.bounds.width += shift;
  right.left += shift;
  right.right += shift;
  if (sideBySide) {
    right.top = left.top;
    right.bottom = left.bottom;
  }
  for (const {a, b} of connections) {
    for (const point of [a, b]) {
      const area = options.protectedAreas.find(({port}) => port === point.port);
      if (point.device === right.id) {
        point.x += shift;
        area.left += shift;
        area.right += shift;
      }
      if (sideBySide) {
        point.y = left.top + 10;
        area.top = point.y - 4;
        area.bottom = point.y + 4;
      }
    }
  }
  return {connections, rows, routes, options};
}

test("a horizontal tube uses vertical port leads and hides lane changes inside the shell", () => {
  const {connections, rows, routes, options} = horizontalFixture();
  const plan = planTubes(connections, rows, routes, {...options, deviceClearance: 25});
  assert.equal(plan.tubes.length, 1);
  const [tube] = plan.tubes;
  assert.equal(tube.axis, "horizontal");
  assert.deepEqual(tube.ids, connections.map(cable => cable.id));
  assert.ok(tube.right - tube.left > 150);
  assert.ok(tube.y + tube.width / 2 + .75 <= options.obstacles[0].top - 25);
  for (const {id, a, b} of connections) {
    const points = plan.paths.get(id);
    assert.deepEqual(points[0], a);
    assert.deepEqual(points.at(-1), b);
    assert.equal(points[1].x, a.x);
    assert.equal(points.at(-2).x, b.x);
    assert.ok(points[1].y < a.y && points.at(-2).y < b.y);
    for (const x of [tube.left, tube.right]) {
      const enters = points.slice(1).some((point, index) => {
        const from = points[index];
        return (point.x - x) * (from.x - x) < 0 &&
          Math.max(Math.abs(point.y - tube.y), Math.abs(from.y - tube.y)) < tube.width / 2;
      });
      assert.ok(enters, "all members pass both sleeve caps");
    }
  }
  const intersections = crossings(plan.paths);
  assert.equal(intersections.length, 28);
  assert.ok(intersections.every(({x, y}) => x > tube.left && x < tube.right && Math.abs(y - tube.y) < tube.width / 2));
});

test("horizontal tubes leave painted clearance at their side and caps", () => {
  const {connections, rows, routes, options} = horizontalFixture();
  const parallelY = 65;
  const crossingX = 320;
  routes.set(98, [{x: 0, y: parallelY}, {x: options.bounds.width, y: parallelY}]);
  routes.set(99, [{x: crossingX, y: 0}, {x: crossingX, y: options.bounds.height}]);
  const {tubes} = planTubes(connections, rows, routes, {...options, deviceClearance: 25, foreignStrokeWidth: 4});
  assert.equal(tubes.length, 1);
  const [tube] = tubes;
  assert.equal(tube.axis, "horizontal");
  assert.equal(tube.parallelGap, 25);
  assert.ok(Math.abs(tube.y - parallelY) - tube.width / 2 >= 25 + 2 + 1);
  assert.ok(tube.right <= crossingX - 18 || tube.left >= crossingX + 18);
  assert.ok(tube.right - tube.left > 55);
});

test("separated banks can use a longer horizontal tube in the gap between stacked devices", () => {
  const {connections, rows, routes, options} = horizontalFixture(false);
  const {tubes} = planTubes(connections, rows, routes, {...options, deviceClearance: 25});
  assert.equal(tubes.length, 1);
  const [tube] = tubes;
  assert.equal(tube.axis, "horizontal");
  assert.ok(tube.right - tube.left > 150);
  assert.ok(tube.y - tube.width / 2 >= options.obstacles[0].bottom + 25);
  assert.ok(tube.y + tube.width / 2 <= options.obstacles[1].top - 25);
});

test("two horizontal tubes preserve clearance between their painted shells", () => {
  const {connections, rows, routes, options} = horizontalFixture();
  routes.delete(3);
  const {tubes} = planTubes(connections.filter(({id}) => id !== 3), rows, routes, options);
  assert.equal(tubes.length, 2);
  const [first, second] = tubes;
  assert.equal(first.axis, "horizontal");
  assert.equal(second.axis, "horizontal");
  assert.ok(first.right > second.left && second.right > first.left);
  const sideGap = Math.abs(first.y - second.y) - (first.width + second.width) / 2;
  assert.ok(sideGap >= Math.max(first.parallelGap, second.parallelGap) + 1.5);
});

test("finds a narrow outside gap close to the device or board edge", () => {
  const {connections, rows, routes, options} = fixture({panel: true});
  routes.set(99, [{x: 315, y: 0}, {x: 315, y: 300}]);
  for (const foreignX of [3.7, 42]) {
    routes.set(100, [{x: foreignX, y: 0}, {x: foreignX, y: 300}]);
    const plan = planTubes(connections, rows, routes, {...options, deviceClearance: 10});
    const tube = assertCompactTube(plan, connections);
    assert.ok(tube.x - tube.width / 2 > 0);
    assert.ok(tube.x + tube.width / 2 + .75 <= 54 - 10);
    assert.ok(Math.abs(tube.x - foreignX) - tube.width / 2 >= 25 + 1);
  }
});

test("keeps one tube when a tight parallel corridor only fits the 15 pixel fallback", () => {
  const {connections, rows, routes, options} = fixture({panel: true});
  routes.set(99, [{x: 315, y: 0}, {x: 315, y: 300}]);
  routes.set(100, [{x: 9.6, y: 0}, {x: 9.6, y: 300}]);
  const plan = planTubes(connections, rows, routes, {...options, deviceClearance: 10, foreignStrokeWidth: 8});
  const tube = assertCompactTube(plan, connections);
  assert.equal(tube.parallelGap, 15);
  assert.ok(Math.abs(tube.x - 9.6) - tube.width / 2 >= 15 + 4 + 1);
});

test("later compact paths leave clearance around tubes already placed", () => {
  const {connections, rows, routes, options} = fixture();
  const reversedBanks = connections.map(({id, a, b}) => {
    const other = connections[(id + 4) % 8];
    const lower = other.a.device === "b" ? other.a : other.b;
    return a.device === "a" ? {id, a, b: lower} : {id, a: lower, b};
  });
  const compactPoints = (_id, points) => roundPath(points, options.protectedAreas, 3).points;
  const plan = planTubes(reversedBanks, rows, routes, {...options, foreignStrokeWidth: 4, compactPoints});
  assert.deepEqual(plan.tubes.map(tube => tube.ids), [[0, 1, 2, 3], [4, 5, 6, 7]]);
  const [first, second] = plan.tubes;
  const capGap = Math.max(0, first.top - second.bottom, second.top - first.bottom);
  const sideGap = Math.max(0, Math.abs(first.x - second.x) - (first.width + second.width) / 2);
  assert.ok(Math.hypot(sideGap, capGap) >= 15 + 1.5);
  if (!capGap) assert.ok(sideGap >= Math.max(first.parallelGap, second.parallelGap) + 1.5);
  for (const tube of plan.tubes) {
    for (const [id, raw] of plan.paths) {
      if (tube.ids.includes(id)) continue;
      const path = compactPoints(id, raw);
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        const count = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
        const parallel = Math.abs(b.y - a.y) >= 4 && Math.abs(b.y - a.y) >= 3 * Math.abs(b.x - a.x);
        for (let step = 0; step <= count; step++) {
          const x = a.x + (b.x - a.x) * step / count;
          const y = a.y + (b.y - a.y) * step / count;
          const dx = Math.max(0, Math.abs(x - tube.x) - tube.width / 2);
          const dy = Math.max(0, tube.top - y, y - tube.bottom);
          assert.ok(Math.hypot(dx, dy) >= 15 + 2 + 1 - 1e-8);
          if (parallel && !dy) assert.ok(dx >= tube.parallelGap + 2 + 1 - 1e-8);
        }
      }
    }
  }
});

test("falls back to ordinary routes when no path can clear an intervening device", () => {
  const {connections, rows, routes, options} = fixture({panel: true});
  options.obstacles.at(-1).left = 0;
  options.obstacles.at(-1).right = options.bounds.width;
  assert.deepEqual(planTubes(connections, rows, routes, options), {paths: new Map(), tubes: []});
});

test("leaves horizontal candidates as ordinary cables when equipment blocks their trunk", () => {
  const {connections, rows, routes, options} = horizontalFixture();
  options.obstacles.push({id: "panel", left: 307, right: 333, top: 0, bottom: options.bounds.height});
  assert.deepEqual(planTubes(connections, rows, routes, options), {paths: new Map(), tubes: []});
});
