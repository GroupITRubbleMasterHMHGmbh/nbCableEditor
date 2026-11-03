(() => {
  "use strict";

  const EPSILON = 1e-7;
  const WIRE_SPACING = 7;
  const CARD_CLEARANCE = 5;
  const PROTECTED_CELL_SIZE = 40;
  const WIRE_CELL_SIZE = 80;

  function orderKey(a, b) {
    const first = String(a);
    const second = String(b);
    return first < second ? -1 : Number(first > second);
  }

  function orderAreas(a, b) {
    return a.left - b.left || a.top - b.top || a.right - b.right || a.bottom - b.bottom ||
      orderKey(a.kind, b.kind) || orderKey(a.id ?? a.port, b.id ?? b.port);
  }

  function clamp(number, low, high) {
    return Math.min(high, Math.max(low, number));
  }

  function cross(ax, ay, bx, by) {
    return ax * by - ay * bx;
  }

  function pointOnSegment(a, b, fraction) {
    return {x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction};
  }

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function describeSegment(a, b, first, last) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < EPSILON) return null;
    return {
      x: a.x, y: a.y, endX: b.x, endY: b.y, dx, dy, length, ux: dx / length, uy: dy / length,
      left: Math.min(a.x, b.x), right: Math.max(a.x, b.x),
      top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y),
      first, last,
    };
  }

  function describeSegments(points) {
    const segments = [];
    for (let i = 1; i < points.length; i++) {
      const segment = describeSegment(points[i - 1], points[i], i === 1, i === points.length - 1);
      if (segment) segments.push(segment);
    }
    return segments;
  }

  function lengthInside(segment, box) {
    if (segment.right <= box.left || segment.left >= box.right ||
        segment.bottom <= box.top || segment.top >= box.bottom) return 0;

    let from = 0;
    let to = 1;
    if (Math.abs(segment.dx) > EPSILON) {
      const t1 = (box.left - segment.x) / segment.dx;
      const t2 = (box.right - segment.x) / segment.dx;
      from = Math.max(from, Math.min(t1, t2));
      to = Math.min(to, Math.max(t1, t2));
    }
    if (Math.abs(segment.dy) > EPSILON) {
      const t1 = (box.top - segment.y) / segment.dy;
      const t2 = (box.bottom - segment.y) / segment.dy;
      from = Math.max(from, Math.min(t1, t2));
      to = Math.min(to, Math.max(t1, t2));
    }
    return Math.max(0, to - from) * segment.length;
  }

  function grid(bounds, size) {
    return {size, columns: Math.floor(bounds.width / size) + 1, rows: Math.floor(bounds.height / size) + 1};
  }

  function visitCells(segment, {size, columns}, visit) {
    let column = Math.floor(segment.x / size);
    let row = Math.floor(segment.y / size);
    const endColumn = Math.floor(segment.endX / size);
    const endRow = Math.floor(segment.endY / size);
    const stepX = Math.sign(segment.dx);
    const stepY = Math.sign(segment.dy);
    const deltaX = stepX ? size / Math.abs(segment.dx) : Infinity;
    const deltaY = stepY ? size / Math.abs(segment.dy) : Infinity;
    let nextX = stepX ? ((column + (stepX > 0 ? 1 : 0)) * size - segment.x) / segment.dx : Infinity;
    let nextY = stepY ? ((row + (stepY > 0 ? 1 : 0)) * size - segment.y) / segment.dy : Infinity;

    // Traverse cells on the segment itself, even when its bounding rectangle spans most of the rack.
    while (true) {
      if (visit(row * columns + column) === false) return;
      if (column === endColumn && row === endRow) return;
      if (column !== endColumn && (row === endRow || nextX <= nextY)) {
        column += stepX;
        nextX += deltaX;
      } else {
        row += stepY;
        nextY += deltaY;
      }
    }
  }

  function samePoint(a, b) {
    return a.x === b.x && a.y === b.y;
  }

  function containsPoint(area, point) {
    return point.x > area.left && point.x < area.right && point.y > area.top && point.y < area.bottom;
  }

  function isOwnMarker(area, port) {
    return area.kind === "port" && port !== undefined && port !== null && area.port === port;
  }

  function protectionIndex(areas, bounds) {
    if (!areas.length) return null;
    const space = grid(bounds, PROTECTED_CELL_SIZE);
    const {size, columns, rows} = space;
    const cells = new Map();
    const ownMarkers = new Map();
    const visited = new Uint32Array(areas.length);
    const hitByRoute = new Uint32Array(areas.length);
    let segmentQuery = 0;
    let routeQuery = 0;

    for (const [index, area] of areas.entries()) {
      if (area.kind === "port") ownMarkers.set(area.port, area);
      const minColumn = clamp(Math.floor(area.left / size), 0, columns - 1);
      const maxColumn = clamp(Math.floor(area.right / size), 0, columns - 1);
      const minRow = clamp(Math.floor(area.top / size), 0, rows - 1);
      const maxRow = clamp(Math.floor(area.bottom / size), 0, rows - 1);
      for (let row = minRow; row <= maxRow; row++) {
        for (let column = minColumn; column <= maxColumn; column++) {
          const cell = row * columns + column;
          if (!cells.has(cell)) cells.set(cell, []);
          cells.get(cell).push(index);
        }
      }
    }

    function intersections(segment, a, b, hit) {
      const query = ++segmentQuery;
      visitCells(segment, space, (cell) => {
        const bucket = cells.get(cell);
        if (!bucket) return;
        for (const index of bucket) {
          if (visited[index] === query) continue;
          visited[index] = query;
          const area = areas[index];
          if ((segment.first && isOwnMarker(area, a.port)) ||
              (segment.last && isOwnMarker(area, b.port))) continue;
          const length = lengthInside(segment, area);
          if (length > EPSILON && hit(index, area, length) === false) return false;
        }
      });
    }

    function measure(segments, {a, b}) {
      const query = ++routeQuery;
      const obstruction = {ports: 0, labels: 0, depth: 0};
      for (const segment of segments) {
        intersections(segment, a, b, (index, area, length) => {
          obstruction.depth += Math.round(length * 100);
          if (hitByRoute[index] === query) return;
          hitByRoute[index] = query;
          if (area.kind === "port") obstruction.ports++;
          else obstruction.labels++;
        });
      }
      return obstruction;
    }

    function clearSegment(connection, a, b) {
      const {a: start, b: end} = connection;
      const segment = describeSegment(a, b,
        samePoint(a, start) || samePoint(b, start), samePoint(a, end) || samePoint(b, end));
      if (!segment) return true;
      let clear = true;
      intersections(segment, start, end, () => {
        clear = false;
        return false;
      });
      return clear;
    }

    function canExit(point) {
      const cell = Math.floor(point.y / size) * columns + Math.floor(point.x / size);
      return !(cells.get(cell) ?? []).some((index) => {
        const area = areas[index];
        return !isOwnMarker(area, point.port) && containsPoint(area, point);
      });
    }

    return {areas, ownMarkers, measure, clearSegment, canExit};
  }

  function fitPoints(points, bounds) {
    const fitted = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const point = points[i];
      const last = i === points.length - 1;
      const next = last ? point : {
        x: clamp(point.x, 0, bounds.width),
        y: clamp(point.y, 0, bounds.height),
      };
      if (distance(fitted.at(-1), next) < EPSILON) {
        // Keep the true endpoint rather than a coincident, rounded bend.
        if (last && fitted.length > 1) fitted.pop();
        if (!last) continue;
      }
      if (fitted.length > 1) {
        const a = fitted.at(-2);
        const b = fitted.at(-1);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const bx = next.x - b.x;
        const by = next.y - b.y;
        if (Math.abs(cross(dx, dy, bx, by)) < EPSILON && dx * bx + dy * by >= 0) fitted.pop();
      }
      fitted.push(next);
    }
    return fitted;
  }

  function routeScore(segments, obstacles, a, b) {
    let score = Math.max(0, segments.length - 1) * 4;
    for (const segment of segments) {
      score += segment.length;
      for (const box of obstacles) {
        if (box.id === a.device || box.id === b.device) continue;
        const inside = lengthInside(segment, box);
        if (inside > EPSILON) score += 2.2 * inside;
      }
    }
    return score;
  }

  function chamfer(points) {
    const softened = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const previous = points[i - 1];
      const point = points[i];
      const next = points[i + 1];
      const before = distance(previous, point);
      const after = distance(point, next);
      const cut = Math.min(12, before / 2, after / 2);
      if (cut < EPSILON) {
        softened.push(point);
        continue;
      }
      softened.push(pointOnSegment(point, previous, cut / before), pointOnSegment(point, next, cut / after));
    }
    softened.push(points.at(-1));
    return softened;
  }

  function corridor(a, b, axis, coordinate) {
    return chamfer([a, {...a, [axis]: coordinate}, {...b, [axis]: coordinate}, b]);
  }

  function corridorCoordinates(a, b, axis, obstacles, direct) {
    const start = a[axis];
    const end = b[axis];
    const middle = (start + end) / 2;
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    const fromEdge = axis === "x" ? "left" : "top";
    const toEdge = axis === "x" ? "right" : "bottom";
    const geometry = [];
    for (const box of obstacles) {
      if (box.id === a.device || box.id === b.device || lengthInside(direct, box) > EPSILON) {
        geometry.push(box[fromEdge] - CARD_CLEARANCE, box[toEdge] + CARD_CLEARANCE);
      }
    }

    // Prefer physical corridors that can be reached with the least extra travel.
    const boundaryDistance = (coordinate) => Math.max(low - coordinate, coordinate - high, 0);
    const order = (p, q) => boundaryDistance(p) - boundaryDistance(q) ||
      Math.abs(p - middle) - Math.abs(q - middle) || p - q;
    const between = new Set(geometry.filter((coordinate) => coordinate >= low && coordinate <= high));
    const below = geometry.filter((coordinate) => coordinate < low).sort(order)[0];
    const above = geometry.filter((coordinate) => coordinate > high).sort(order)[0];

    return [
      start - 11, start + 11, end - 11, end + 11,
      middle, middle - 14, middle + 14,
      ...Array.from(between).sort(order).slice(0, 4),
      below, above,
    ].filter(Number.isFinite);
  }

  function bridgeCards(a, b, boxA, boxB, axis, add) {
    if (!boxA || !boxB || boxA === boxB) return;
    const [low, high, other, otherLow, otherHigh] = axis === "x"
      ? ["left", "right", "y", "top", "bottom"]
      : ["top", "bottom", "x", "left", "right"];
    const forwards = boxA[high] <= boxB[low];
    if (!forwards && boxB[high] > boxA[low]) return;
    const edgeA = boxA[forwards ? high : low];
    const edgeB = boxB[forwards ? low : high];
    const clearance = Math.sign(edgeB - edgeA) * Math.min(CARD_CLEARANCE, Math.abs(edgeB - edgeA) / 4);

    // Route along each device's face and spend the change in rack height in the physical gap.
    for (const [shiftA, shiftB] of [[0, 0], [-8, 8], [8, -8], [-8, -8], [8, 8], [-16, 16], [16, -16]]) {
      const exit = {[axis]: edgeA + clearance, [other]: clamp(a[other] + shiftA, boxA[otherLow], boxA[otherHigh])};
      const entry = {[axis]: edgeB - clearance, [other]: clamp(b[other] + shiftB, boxB[otherLow], boxB[otherHigh])};
      add([a, exit, entry, b]);
    }
  }

  function bypassObstacles(a, b, obstacles, direct, add) {
    const boxes = obstacles.filter((box) => box.id !== a.device && box.id !== b.device)
      .map((box) => ({box, inside: lengthInside(direct, box)}))
      .filter(({inside}) => inside > EPSILON)
      .sort((p, q) => q.inside - p.inside || p.box.left - q.box.left || p.box.top - q.box.top)
      .slice(0, 2);
    const horizontal = Math.abs(direct.dx) >= Math.abs(direct.dy);
    for (const {box} of boxes) {
      const aEdge = horizontal ? box.left - CARD_CLEARANCE : box.top - CARD_CLEARANCE;
      const bEdge = horizontal ? box.right + CARD_CLEARANCE : box.bottom + CARD_CLEARANCE;
      const sides = horizontal ? [box.top - CARD_CLEARANCE, box.bottom + CARD_CLEARANCE] :
        [box.left - CARD_CLEARANCE, box.right + CARD_CLEARANCE];
      const forwards = horizontal ? direct.dx > 0 : direct.dy > 0;
      for (const side of sides) {
        const entry = forwards ? aEdge : bEdge;
        const exit = forwards ? bEdge : aEdge;
        add(horizontal ? [a, {x: entry, y: side}, {x: exit, y: side}, b] :
          [a, {x: side, y: entry}, {x: side, y: exit}, b]);
      }
    }
  }

  function compareObstruction(a, b) {
    // A clear path wins unconditionally. Otherwise a blocked marker costs more than a blocked label.
    const aObstructions = a.ports * 2 + a.labels;
    const bObstructions = b.ports * 2 + b.labels;
    return aObstructions - bObstructions || a.ports - b.ports;
  }

  function isClear(candidate) {
    return !candidate.obstruction.ports && !candidate.obstruction.labels;
  }

  function terminalLeads(connection, start, end, protection, bounds) {
    const marker = protection.ownMarkers.get(start.port);
    const horizontal = marker ? Math.max(start.x - marker.left, marker.right - start.x) + 3 : 12;
    const vertical = marker ? Math.max(start.y - marker.top, marker.bottom - start.y) + 3 : 12;
    const leads = [];
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        if (!dx && !dy) continue;
        const lead = {
          x: clamp(start.x + dx * horizontal, 0, bounds.width),
          y: clamp(start.y + dy * vertical, 0, bounds.height),
        };
        if (!samePoint(start, lead) && protection.clearSegment(connection, start, lead)) leads.push(lead);
      }
    }
    return leads.sort((a, b) => distance(a, end) - distance(b, end)).slice(0, 4);
  }

  function protectedCandidates(connection, protection, bounds, list, add) {
    if (!protection.canExit(connection.a) || !protection.canExit(connection.b)) return;
    const {a, b} = connection;
    const leadsA = terminalLeads(connection, a, b, protection, bounds);
    const leadsB = terminalLeads(connection, b, a, protection, bounds);
    for (const first of leadsA) {
      for (const last of leadsB) {
        add([a, first, last, b]);
      }
    }
    if (list.some(isClear)) return;

    const corridors = globalThis.NetBoxRackCorridors;
    if (!corridors) return;
    const alternatives = corridors.candidates(connection, protection.areas, bounds,
      (start, end) => protection.clearSegment(connection, start, end));
    for (const points of alternatives.slice(0, 4)) {
      if (points.length >= 2 && samePoint(points[0], a) && samePoint(points.at(-1), b)) add(points);
    }
  }

  function addLaneAlternatives(list, add, seedLimit) {
    const paths = list.filter(isClear).sort((a, b) => a.base - b.base);
    if (!paths.length || paths.length >= 8) return;
    for (const {points, segments} of paths.slice(0, seedLimit)) {
      const longest = segments.reduce((best, segment, index) =>
        segment.length > segments[best].length ? index : best, 0);
      const segment = segments[longest];
      if (!segment) continue;
      const a = points[longest];
      const b = points[longest + 1];
      // Shift the long part into parallel tracks where the surrounding free space permits it.
      const u = pointOnSegment(a, b, .16);
      const v = pointOnSegment(a, b, .84);
      for (const offset of [-9, -4, -1.5, 1.5, 4, 9]) {
        const dx = -segment.uy * offset;
        const dy = segment.ux * offset;
        add([...points.slice(0, longest + 1), {x: u.x + dx, y: u.y + dy},
          {x: v.x + dx, y: v.y + dy}, ...points.slice(longest + 1)], true);
      }
      if (points.length <= 2) continue;
      // A narrow lane often sits on the edge of a port row; nudge the bends without moving the ports.
      for (const axis of ["x", "y"]) {
        for (const offset of [-4, -1.5, 1.5, 4]) {
          add([points[0], ...points.slice(1, -1).map((point) => ({
            ...point, [axis]: point[axis] + offset,
          })), points.at(-1)], true);
        }
      }
    }
  }

  function pathBounds(points) {
    const box = {left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity};
    for (const {x, y} of points) {
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y);
    }
    return box;
  }

  function candidates(connection, obstacles, bounds, protection, laneSeedLimit) {
    const {a, b} = connection;
    const list = [];
    const seen = new Set();

    function add(points, onlyClear = false) {
      const fitted = fitPoints(points, bounds);
      const key = fitted.map(({x, y}) => protection
        ? x + ":" + y
        : Math.round(x * 2) + ":" + Math.round(y * 2)).join("/");
      if (seen.has(key)) return;
      seen.add(key);
      const segments = describeSegments(fitted);
      const obstruction = protection?.measure(segments, connection) ?? {ports: 0, labels: 0, depth: 0};
      if (onlyClear && (obstruction.ports || obstruction.labels)) return;
      list.push({
        points: fitted.map(({x, y}) => ({x, y})),
        segments,
        box: pathBounds(fitted),
        base: routeScore(segments, obstacles, a, b) + 2 * obstruction.depth / 100,
        obstruction,
      });
    }

    add([a, b]);
    const direct = list[0].segments[0];
    if (!direct) return list;

    const start = pointOnSegment(a, b, .28);
    const end = pointOnSegment(a, b, .72);
    const offsetLimit = Math.min(100, 12 + direct.length * .44);
    for (const offset of [8, 16, 28, 44, 68, 96]) {
      if (offset > offsetLimit) break;
      for (const side of [-1, 1]) {
        const dx = -direct.uy * offset * side;
        const dy = direct.ux * offset * side;
        add([a, {x: start.x + dx, y: start.y + dy}, {x: end.x + dx, y: end.y + dy}, b]);
      }
    }

    const boxA = obstacles.find((box) => box.id === a.device);
    const boxB = obstacles.find((box) => box.id === b.device);
    bypassObstacles(a, b, obstacles, direct, add);
    for (const axis of ["x", "y"]) {
      bridgeCards(a, b, boxA, boxB, axis, add);
      for (const coordinate of corridorCoordinates(a, b, axis, obstacles, direct)) {
        add(corridor(a, b, axis, coordinate));
      }
    }
    if (protection) {
      if (list.filter(isClear).length < 3) protectedCandidates(connection, protection, bounds, list, add);
      addLaneAlternatives(list, add, laneSeedLimit);
    }
    return list.sort((p, q) => compareObstruction(p.obstruction, q.obstruction) || p.base - q.base);
  }

  function parallelCost(a, b, dx, dy, sin) {
    const along = dx * a.ux + dy * a.uy;
    const cosine = a.ux * b.ux + a.uy * b.uy;
    const end = along + b.length * cosine;
    let from = Math.max(0, Math.min(along, end));
    let to = Math.min(a.length, Math.max(along, end));
    if (to <= from) return 0;
    const perpendicular = cross(a.ux, a.uy, dx, dy);
    const gradient = sin / cosine;
    if (Math.abs(gradient) > EPSILON) {
      const enters = along + (-WIRE_SPACING - perpendicular) / gradient;
      const exits = along + (WIRE_SPACING - perpendicular) / gradient;
      from = Math.max(from, Math.min(enters, exits));
      to = Math.min(to, Math.max(enters, exits));
      if (to <= from) return 0;
    } else if (Math.abs(perpendicular) >= WIRE_SPACING) {
      return 0;
    }
    const separation = Math.abs(perpendicular + ((from + to) / 2 - along) * gradient);
    return (to - from) * (0.3 + 2.3 * (1 - separation / WIRE_SPACING));
  }

  function isEndpoint(segment, at) {
    return (segment.first && at < EPSILON) || (segment.last && segment.length - at < EPSILON);
  }

  function near(a, b) {
    return a.right + WIRE_SPACING >= b.left && b.right + WIRE_SPACING >= a.left &&
      a.bottom + WIRE_SPACING >= b.top && b.bottom + WIRE_SPACING >= a.top;
  }

  function pairCost(first, second, budget) {
    if (!near(first.box, second.box)) return 0;
    let cost = 0;
    let intersections;
    for (const a of first.segments) {
      for (const b of second.segments) {
        if (!near(a, b)) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const sin = cross(a.ux, a.uy, b.ux, b.uy);
        const angle = Math.abs(sin);
        if (angle < .3) {
          // Average both projections so the cost is independent of route evaluation order.
          cost += (parallelCost(a, b, dx, dy, sin) + parallelCost(b, a, -dx, -dy, -sin)) / 2;
        }
        if (angle > EPSILON) {
          const t = cross(dx, dy, b.ux, b.uy) / sin;
          const u = cross(dx, dy, a.ux, a.uy) / sin;
          if (t >= -EPSILON && t <= a.length + EPSILON && u >= -EPSILON && u <= b.length + EPSILON &&
              !(isEndpoint(a, t) && isEndpoint(b, u))) {
            const x = a.x + a.ux * t;
            const y = a.y + a.uy * t;
            if (!intersections?.some((point) => Math.abs(point.x - x) < .5 && Math.abs(point.y - y) < .5)) {
              (intersections ??= []).push({x, y});
              cost += 29 + 13 * (1 - angle);
            }
          }
        }
        if (cost >= budget) return cost;
      }
    }
    return cost;
  }

  function wireIndex(entries, bounds) {
    const space = grid(bounds, WIRE_CELL_SIZE);
    const {columns, rows} = space;
    const buckets = new Map();
    const neighbors = new Uint32Array(Math.ceil(entries.length / 32));

    function cellsOf(candidate) {
      if (!candidate.cells) {
        const cells = new Set();
        for (const segment of candidate.segments) visitCells(segment, space, (cell) => cells.add(cell));
        candidate.cells = cells;
      }
      return candidate.cells;
    }

    function nearbyCells(candidate) {
      if (!candidate.nearbyCells) {
        const nearby = new Set();
        for (const cell of cellsOf(candidate)) {
          const row = Math.floor(cell / columns);
          const column = cell % columns;
          for (let y = Math.max(0, row - 1); y <= Math.min(rows - 1, row + 1); y++) {
            for (let x = Math.max(0, column - 1); x <= Math.min(columns - 1, column + 1); x++) {
              nearby.add(y * columns + x);
            }
          }
        }
        candidate.nearbyCells = nearby;
      }
      return candidate.nearbyCells;
    }

    function set(entry, next) {
      const block = entry.index >>> 5;
      const bit = 1 << (entry.index & 31);
      if (entry.route) {
        for (const cell of cellsOf(entry.route)) buckets.get(cell)[block] &= ~bit;
      }
      for (const cell of cellsOf(next)) {
        if (!buckets.has(cell)) buckets.set(cell, new Uint32Array(neighbors.length));
        buckets.get(cell)[block] |= bit;
      }
      entry.route = next;
    }

    function visit(candidate, callback) {
      neighbors.fill(0);
      for (const cell of nearbyCells(candidate)) {
        const bucket = buckets.get(cell);
        if (!bucket) continue;
        for (let block = 0; block < neighbors.length; block++) neighbors[block] |= bucket[block];
      }
      // Iterate in route order so the summed cost is independent of cell insertion order.
      for (let block = 0; block < neighbors.length; block++) {
        for (let bits = neighbors[block]; bits; bits &= bits - 1) {
          const index = block * 32 + 31 - Math.clz32(bits & -bits);
          if (callback(entries[index]) === false) return;
        }
      }
    }

    return {set, visit};
  }

  function choose(entry, entries, index, candidateLimit) {
    let best = null;
    let bestScore = Infinity;
    const leastObstruction = entry.candidates[0].obstruction;
    for (let i = 0; i < Math.min(entry.candidates.length, candidateLimit); i++) {
      const candidate = entry.candidates[i];
      if (compareObstruction(candidate.obstruction, leastObstruction) || candidate.base >= bestScore) break;
      let score = candidate.base;
      const addCost = (other) => {
        if (entry !== other && other.route) score += pairCost(candidate, other.route, bestScore - score);
        return score < bestScore;
      };
      if (index) {
        index.visit(candidate, addCost);
      } else {
        for (const other of entries) {
          if (!addCost(other)) break;
        }
      }
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  function routeCables(connections, obstacles, bounds, protectedAreas = []) {
    const protection = protectionIndex([...protectedAreas].sort(orderAreas), bounds);
    const deviceBoxes = [...obstacles].sort(orderAreas);
    const laneSeedLimit = connections.length > 128 ? 1 : 2;
    const entries = connections.map((connection) => ({
      id: connection.id,
      length: distance(connection.a, connection.b),
      candidates: candidates(connection, deviceBoxes, bounds, protection, laneSeedLimit),
      route: null,
    })).sort((a, b) => {
      return a.length - b.length || orderKey(a.id, b.id);
    });

    const index = entries.length > 96 ? wireIndex(entries, bounds) : null;
    const candidateLimit = entries.length > 256 ? 14 : (entries.length > 128 ? 22 : Infinity);
    entries.forEach((entry, i) => { entry.index = i; });
    function place(entry) {
      const route = choose(entry, entries, index, candidateLimit);
      if (route === entry.route) return false;
      if (index) index.set(entry, route);
      else entry.route = route;
      return true;
    }

    for (const entry of entries) place(entry);

    // Give routes placed early a chance to move after their neighbors are known.
    const sweeps = entries.length > 96 ? 1 : 2;
    for (let sweep = 0; sweep < sweeps; sweep++) {
      let changed = false;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[sweep === 0 ? entries.length - 1 - i : i];
        if (place(entry)) changed = true;
      }
      if (!changed) break;
    }
    return new Map(entries.map(({id, route}) => [id, route.points]));
  }

  globalThis.NetBoxRackRouting = {routeCables};
})();
