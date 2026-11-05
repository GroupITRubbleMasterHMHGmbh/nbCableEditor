(() => {
  "use strict";

  const EPSILON = 1e-7;
  const WIRE_SPACING = 7;
  const CARD_CLEARANCE = 5;
  const PROTECTED_CELL_SIZE = 40;
  const WIRE_CELL_SIZE = 80;
  const PCB_SPACING = 5;
  const PCB_MIN_SPACING = 3.2;
  const PCB_CLEARANCE = 2;

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

  function bypassObstacles(a, b, obstacles, direct, add, spacing, tracks = 1) {
    const boxes = obstacles.filter((box) => box.id !== a.device && box.id !== b.device)
      .map((box) => ({box, inside: lengthInside(direct, box)}))
      .filter(({inside}) => inside > EPSILON)
      .sort((p, q) => q.inside - p.inside || p.box.left - q.box.left || p.box.top - q.box.top)
      .slice(0, 2);
    const horizontal = Math.abs(direct.dx) >= Math.abs(direct.dy);
    const pitch = spacing?.[horizontal ? "y" : "x"] ?? 0;
    for (const {box} of boxes) {
      const aEdge = horizontal ? box.left - CARD_CLEARANCE : box.top - CARD_CLEARANCE;
      const bEdge = horizontal ? box.right + CARD_CLEARANCE : box.bottom + CARD_CLEARANCE;
      const sides = horizontal ? [box.top - CARD_CLEARANCE, box.bottom + CARD_CLEARANCE] :
        [box.left - CARD_CLEARANCE, box.right + CARD_CLEARANCE];
      const forwards = horizontal ? direct.dx > 0 : direct.dy > 0;
      for (const [index, edge] of sides.entries()) {
        for (let track = 0; track < tracks; track++) {
          const offset = track * pitch;
          const leadOffset = track * (spacing?.x ?? 0);
          const entry = forwards ? aEdge - leadOffset : bEdge + leadOffset;
          const exit = forwards ? bEdge + leadOffset : aEdge - leadOffset;
          const side = edge + (index === 0 ? -1 : 1) * offset;
          add(horizontal ? [a, {x: entry, y: side}, {x: exit, y: side}, b] :
            [a, {x: side, y: entry}, {x: side, y: exit}, b]);
        }
      }
    }
  }

  function compareObstruction(a, b) {
    // A clear path wins unconditionally. Otherwise a blocked marker costs more than a blocked label.
    const aObstructions = a.ports * 2 + a.labels;
    const bObstructions = b.ports * 2 + b.labels;
    return (a.cards ?? 0) - (b.cards ?? 0) || aObstructions - bObstructions || a.ports - b.ports ||
      (a.exits ?? 0) - (b.exits ?? 0);
  }

  function isClear(candidate) {
    return !candidate.obstruction.cards && !candidate.obstruction.ports && !candidate.obstruction.labels;
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

    const corridors = globalThis.NbCableEditorCorridors;
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

  function pcbAxis(axis) {
    return axis === "x" ? ["y", "left", "right", "top", "bottom"] : ["x", "top", "bottom", "left", "right"];
  }

  function pcbWindows(axis, from, to, obstacles, bounds) {
    const [, low, high, start, end] = pcbAxis(axis);
    const limit = (axis === "x" ? bounds.width : bounds.height) - PCB_CLEARANCE;
    const first = Math.min(from, to);
    const last = Math.max(from, to);
    const blocked = obstacles.filter(box => box[start] <= last && box[end] >= first)
      .sort((a, b) => a[low] - b[low] || a[high] - b[high]);
    const free = [];
    let left = PCB_CLEARANCE;
    for (const box of blocked) {
      const right = Math.min(limit, box[low] - PCB_CLEARANCE);
      if (right >= left) free.push([left, right]);
      left = Math.max(left, box[high] + PCB_CLEARANCE);
      if (left > limit) return free;
    }
    if (limit >= left) free.push([left, limit]);
    return free;
  }

  function pcbTracks(windows, preferred, lane, laneCount, spacing) {
    const dist = ([left, right]) => Math.max(left - preferred, preferred - right, 0);
    const nearby = windows.sort((a, b) => dist(a) - dist(b) || a[0] - b[0]).slice(0, 4);
    const tracks = new Set();
    const demand = Math.min(24, Math.ceil(laneCount / 2));
    const minimumPitch = spacing > PCB_SPACING ? spacing : PCB_MIN_SPACING;
    for (const [left, right] of nearby) {
      const width = right - left;
      const pitch = clamp(width / Math.max(1, demand - 1), minimumPitch, spacing);
      const count = Math.floor((width + EPSILON) / pitch) + 1;
      const middle = (left + right) / 2;
      const first = middle - (count - 1) * pitch / 2;
      const closest = clamp(Math.round((preferred - first) / pitch), 0, count - 1);
      const candidates = count <= 8 ? Array.from({length: count}, (_, i) => i) :
        [closest, closest - 1, closest + 1, closest - 3, closest + 3, lane % count, (lane + 7) % count,
          count - 1 - lane % count, count - 1 - (lane + 7) % count];
      for (const i of candidates) {
        if (i >= 0 && i < count) tracks.add(first + i * pitch);
      }
    }
    return [...tracks];
  }

  function pcbEscapes(connection, port, axis, rail, protection, bounds) {
    const [other, , , start, finish] = pcbAxis(axis);
    const marker = protection?.ownMarkers.get(port.port);
    const offset = marker ? Math.max(port[other] - marker[start], marker[finish] - port[other]) + 1 : 6;
    const span = rail - port[axis];
    const limit = other === "x" ? bounds.width : bounds.height;
    const escapes = [];
    for (const shift of [0, -offset, offset, -offset - 2, offset + 2]) {
      const at = port[other] + shift;
      if (at < 0 || at > limit) continue;
      const end = {[axis]: rail, [other]: at};
      // A shallower lead can move sideways past a wide label before turning toward the rail.
      const turns = (shift ? [1, .65] : [1]).map(slope => ({
        [axis]: port[axis] + Math.sign(span) * Math.min(Math.abs(shift) * slope, Math.abs(span)),
        [other]: at,
      }));
      const turn = protection ? turns.find(point => protection.clearSegment(connection, port, point) &&
        protection.clearSegment(connection, point, end)) : turns[0];
      if (turn) {
        escapes.push(shift ? [port, turn, end] : [port, end]);
        if (escapes.length === 2) break;
      }
    }
    return escapes.length ? escapes : [[port, {[axis]: rail, [other]: port[other]}]];
  }

  function pcbFanout(port, axis, track, edge, outerEdge, obstacles, bounds, lane, depth, spacing) {
    const [other] = pcbAxis(axis);
    const windows = pcbWindows(axis, port[other], track, obstacles, bounds);
    const distanceToEdge = ([low, high]) => Math.max(low - edge, edge - high, 0);
    windows.sort((a, b) => distanceToEdge(a) - distanceToEdge(b) || a[0] - b[0]);
    const near = windows[0] ?? [port[axis], port[axis]];
    const outer = windows.find(([low, high]) => outerEdge < edge ? high <= outerEdge : low >= outerEdge);
    function spaced([low, high]) {
      const width = high - low;
      const pitch = spacing > PCB_SPACING ? spacing : Math.min(spacing, width / 12);
      const count = pitch > EPSILON ? Math.floor(width / pitch) + 1 : 1;
      const first = (low + high - (count - 1) * pitch) / 2;
      return first + (lane % count) * pitch;
    }
    const [low, high] = near;
    const close = clamp(edge, low, high);
    const opposite = close - low < high - close ? high : low;
    const exterior = outer ?? windows[1] ?? near;
    const outerClose = clamp(outerEdge, ...exterior);
    const outerFar = outerEdge < edge ? exterior[0] : exterior[1];
    const outerSteps = Math.floor(Math.abs(outerFar - outerClose) / spacing);
    return {close, spaced: spaced(near), outer: spaced(exterior), outerClose,
      outerNested: outerClose + Math.sign(outerFar - outerClose) * Math.round(outerSteps * depth) * spacing,
      nested: opposite + (close - opposite) * depth};
  }

  function pcbDetours(connection, axis, obstacles, boxA, boxB, bounds, lane, laneCount, spacing, escapes, add, exits) {
    if (!boxA || !boxB) return;
    const {a, b} = connection;
    const [other, low, high] = pcbAxis(axis);
    const forwards = boxA[high] <= boxB[low];
    if (!forwards && boxB[high] > boxA[low]) return;
    const firstEdge = boxA[forwards ? high : low];
    const lastEdge = boxB[forwards ? low : high];
    const firstOuter = boxA[forwards ? low : high];
    const lastOuter = boxB[forwards ? high : low];
    const middle = (a[other] + b[other]) / 2;
    const windows = pcbWindows(other, a[axis], b[axis], obstacles, bounds);
    const tracks = pcbTracks(windows, middle, lane, laneCount, spacing[other]);
    const pairs = [["close", "close"], ["spaced", "spaced"], ["spaced", "outer"],
      ["outer", "spaced"], ["outer", "outer"], ["nested", "nested"], ["nested", "outer"],
      ["outer", "nested"], ["nested", "spaced"], ["spaced", "nested"]];
    if (axis === "y" && exits) {
      const outerA = exits[0] === (forwards ? "top" : "bottom");
      const outerB = exits[1] === (forwards ? "bottom" : "top");
      if (outerA || outerB) {
        const nearA = outerA ? "outerClose" : "close";
        const nearB = outerB ? "outerClose" : "close";
        const nestedA = outerA ? "outerNested" : "nested";
        const nestedB = outerB ? "outerNested" : "nested";
        // An outside lead has more room for its turn on tracks farther from the chassis.
        pairs.push([nearA, nearB], [nestedA, nestedB], [nearA, nestedB], [nestedA, nearB]);
      }
    }
    for (const rail of tracks) {
      const [min, max] = windows.find(([low, high]) => rail >= low - EPSILON && rail <= high + EPSILON);
      const depth = clamp((rail < middle ? max - rail : rail - min) / Math.max(1, max - min), 0, 1);
      const firstRails = pcbFanout(a, axis, rail, firstEdge, firstOuter, obstacles, bounds, lane, depth, spacing[axis]);
      const lastRails = pcbFanout(b, axis, rail, lastEdge, lastOuter, obstacles, bounds, 17 * lane + 5, depth, spacing[axis]);
      // Start with the short route. Give each endpoint an independent choice of the outer bay.
      // Nest deeper tracks closer to the devices so fan-outs do not have to cross the inner lanes.
      for (const [p, q] of pairs) {
        const firstRail = firstRails[p];
        const lastRail = lastRails[q];
        const starts = escapes(a, axis, firstRail);
        const ends = escapes(b, axis, lastRail);
        for (const [i, first] of starts.entries()) {
          const last = ends[Math.min(i, ends.length - 1)];
          add([...first, {[axis]: firstRail, [other]: rail}, {[axis]: lastRail, [other]: rail}, ...last.slice().reverse()]);
        }
      }
    }
  }

  function pcbCandidates(connection, obstacles, bounds, protection, lane, laneCount, spacing, add, exits) {
    const {a, b} = connection;
    const boxA = obstacles.find(box => box.id === a.device);
    const boxB = obstacles.find(box => box.id === b.device);
    const memo = new Map();
    function escapes(port, axis, rail) {
      const key = (port === a ? "A" : "B") + axis + rail;
      if (!memo.has(key)) memo.set(key, pcbEscapes(connection, port, axis, rail, protection, bounds));
      return memo.get(key);
    }

    for (const axis of ["x", "y"]) {
      const [other] = pcbAxis(axis);
      const windows = pcbWindows(axis, a[other], b[other], obstacles, bounds);
      for (const rail of pcbTracks(windows, (a[axis] + b[axis]) / 2, lane, laneCount, spacing[axis])) {
        const starts = escapes(a, axis, rail);
        const ends = escapes(b, axis, rail);
        for (const first of starts) {
          for (const last of ends) add([...first, ...last.slice().reverse()]);
        }
      }
      pcbDetours(connection, axis, obstacles, boxA, boxB, bounds, lane, laneCount, spacing, escapes, add, exits);
    }
  }

  function pcbFallback(connection, obstacles, bounds, protection, add) {
    const corridors = globalThis.NbCableEditorCorridors;
    if (!corridors) return;
    const areas = [...obstacles, ...(protection?.areas ?? [])];
    const clear = (a, b) => {
      const segment = describeSegment(a, b, false, false);
      return (!segment || !obstacles.some(box => lengthInside(segment, box) > EPSILON)) &&
        (!protection || protection.clearSegment(connection, a, b));
    };
    for (const points of corridors.candidates(connection, areas, bounds, clear)) {
      if (points.length >= 2 && samePoint(points[0], connection.a) && samePoint(points.at(-1), connection.b)) add(points);
    }
  }

  function pcbExitCost(port, card, next) {
    if (!card || !next || card.right - card.left <= card.bottom - card.top) return 0;
    const row = port.y - (card.top + card.bottom) / 2;
    return row * (next.y - port.y) < 0 ? Math.min(64, Math.abs(row) * 5) : 0;
  }

  function visibleOuterRows(cards, protection) {
    const rows = new Map();
    if (!protection) return rows;
    const centers = [...protection.ownMarkers.values()].map(box => ({
      x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2,
    }));
    for (const card of cards) {
      const height = card.bottom - card.top;
      if (card.right - card.left <= height) continue;
      let top = Infinity;
      let bottom = -Infinity;
      for (const point of centers) {
        if (!containsPoint(card, point)) continue;
        top = Math.min(top, point.y);
        bottom = Math.max(bottom, point.y);
      }
      if (bottom - top >= Math.max(4, .15 * height)) rows.set(card.id, {top, bottom, tolerance: .07 * height});
    }
    return rows;
  }

  function rowExit(port, rows) {
    const row = rows.get(port.device);
    if (!row || port.port === undefined) return null;
    if (Math.abs(port.y - row.top) <= row.tolerance) return "top";
    if (Math.abs(port.y - row.bottom) <= row.tolerance) return "bottom";
    return null;
  }

  function leavesThrough(points, card, side, step) {
    const edge = card[side];
    for (let index = step > 0 ? 1 : points.length - 2; index >= 0 && index < points.length; index += step) {
      const next = points[index];
      const previous = points[index - step];
      if (side === "top" ? next.y <= edge : next.y >= edge) {
        const fraction = next.y === previous.y ? 0 : (edge - previous.y) / (next.y - previous.y);
        const x = previous.x + (next.x - previous.x) * fraction;
        return x >= card.left - EPSILON && x <= card.right + EPSILON;
      }
      if (!containsPoint(card, next)) return false;
    }
    return false;
  }

  function terminalClearanceLoss(segments, card, port, otherPort) {
    if (!card) return 0;
    // A lead must cross its own device buffer. Charge only the travel beyond a short escape.
    const allowance = ({x, y}) => Math.max(0, Math.min(x - card.left, card.right - x, y - card.top, card.bottom - y) + 8);
    const permitted = allowance(port) + (otherPort ? allowance(otherPort) : 0);
    const inside = segments.reduce((length, segment) => length + lengthInside(segment, card), 0);
    return Math.max(0, inside - permitted);
  }

  function candidates(connection, obstacles, routingBoxes, bounds, protection, rows, laneSeedLimit, pcb, lane, laneCount, spacing) {
    const {a, b} = connection;
    const list = [];
    const seen = new Set();
    const unrelated = obstacles.filter(box => box.id !== a.device && box.id !== b.device);
    const hasClearance = routingBoxes !== obstacles;
    const buffers = hasClearance ? routingBoxes.filter(box => box.id !== a.device && box.id !== b.device) : [];
    const boxA = obstacles.find(box => box.id === a.device);
    const boxB = obstacles.find(box => box.id === b.device);
    const bufferA = hasClearance ? routingBoxes.find(box => box.id === a.device) : null;
    const bufferB = hasClearance ? routingBoxes.find(box => box.id === b.device) : null;
    const stacked = boxA && boxB && (boxA.bottom <= boxB.top || boxB.bottom <= boxA.top) &&
      boxA.left < boxB.right && boxB.left < boxA.right;
    const exitA = stacked ? rowExit(a, rows) : null;
    const exitB = stacked ? rowExit(b, rows) : null;
    const exits = exitA || exitB ? [exitA, exitB] : null;
    const clearExit = candidate => isClear(candidate) && !candidate.obstruction.exits;

    function add(points, onlyClear = false) {
      const fitted = fitPoints(points, bounds);
      const key = fitted.map(({x, y}) => protection || pcb
        ? x + ":" + y
        : Math.round(x * 2) + ":" + Math.round(y * 2)).join("/");
      if (seen.has(key)) return;
      seen.add(key);
      const segments = describeSegments(fitted);
      const obstruction = protection?.measure(segments, connection) ?? {ports: 0, labels: 0, depth: 0};
      if (onlyClear && (obstruction.ports || obstruction.labels)) return;
      let cardLength = 0;
      let cardCount = 0;
      for (const box of unrelated) {
        const inside = segments.reduce((length, segment) => length + lengthInside(segment, box), 0);
        if (inside > EPSILON) {
          cardLength += inside;
          cardCount++;
        }
      }
      if (pcb || hasClearance) obstruction.cards = cardCount;
      if (onlyClear && obstruction.cards) return;
      if (exits) {
        obstruction.exits = Number(Boolean(exitA) && !leavesThrough(fitted, boxA, exitA, 1)) +
          Number(Boolean(exitB) && !leavesThrough(fitted, boxB, exitB, -1));
      }
      let clearanceLoss = 0;
      for (const box of buffers) {
        for (const segment of segments) clearanceLoss += lengthInside(segment, box);
      }
      const terminalLoss = bufferA === bufferB ? terminalClearanceLoss(segments, bufferA, a, b) :
        terminalClearanceLoss(segments, bufferA, a) + terminalClearanceLoss(segments, bufferB, b);
      const length = segments.reduce((length, segment) => length + segment.length, 0);
      let base = length + Math.max(0, segments.length - 1) * 4 + 2.2 * cardLength + 2 * obstruction.depth / 100;
      if (pcb && boxA !== boxB) {
        base = .75 * base + pcbExitCost(a, boxA, fitted[1]) + pcbExitCost(b, boxB, fitted.at(-2));
      }
      list.push({
        points: fitted.map(({x, y}) => ({x, y})),
        segments,
        box: pathBounds(fitted),
        base: base + 5 * clearanceLoss + 2 * terminalLoss,
        obstruction,
        clearanceLoss,
        length,
      });
    }

    function orderedCandidates() {
      list.sort((p, q) => compareObstruction(p.obstruction, q.obstruction) || p.base - q.base);
      if (!buffers.length) return list;
      const safest = list.filter(candidate => !compareObstruction(candidate.obstruction, list[0].obstruction));
      const roomy = safest.filter(candidate => candidate.clearanceLoss < EPSILON);
      const shortest = safest.reduce((best, candidate) => Math.min(best, candidate.length), Infinity);
      // Preserve clearance when a comparably short route can do so. Narrow gaps still get a usable fallback.
      return roomy.some(candidate => candidate.length <= shortest * 1.35 + 2 * spacing.x) ? roomy : list;
    }

    add([a, b]);
    const direct = list[0].segments[0];
    if (!direct) return list;
    if (pcb) {
      pcbCandidates(connection, routingBoxes, bounds, protection, lane, laneCount, spacing, add, exits);
      if (hasClearance && list.filter(candidate => clearExit(candidate) && candidate.clearanceLoss < EPSILON).length < 3) {
        pcbCandidates(connection, obstacles, bounds, protection, lane, laneCount, spacing, add, exits);
      }
      if (!list.some(isClear)) pcbFallback(connection, unrelated, bounds, protection, add);
      if (list.some(isClear)) return orderedCandidates();
    }

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

    bypassObstacles(a, b, obstacles, direct, add);
    if (hasClearance) {
      bypassObstacles(a, b, routingBoxes, direct, add, spacing, Math.min(10, laneCount));
    }
    for (const axis of ["x", "y"]) {
      bridgeCards(a, b, boxA, boxB, axis, add);
      const coordinates = corridorCoordinates(a, b, axis, obstacles, direct);
      if (hasClearance) coordinates.push(...corridorCoordinates(a, b, axis, routingBoxes, direct));
      if (axis === "y" && spacing.y > spacing.x) {
        const windows = pcbWindows(axis, a.x, b.x, routingBoxes, bounds);
        coordinates.push(...pcbTracks(windows, (a.y + b.y) / 2, lane, laneCount, spacing.y));
      }
      for (const coordinate of new Set(coordinates)) {
        add(corridor(a, b, axis, coordinate));
      }
    }
    const targetLanes = Math.min(16, 2 * laneCount + 2);
    if (hasClearance && !pcb &&
        list.filter(candidate => clearExit(candidate) && candidate.clearanceLoss < EPSILON).length < targetLanes) {
      const addChamfered = points => add(chamfer(points), true);
      pcbCandidates(connection, routingBoxes, bounds, protection, lane, laneCount, spacing, addChamfered, exits);
      if (list.filter(clearExit).length < 3) {
        pcbCandidates(connection, obstacles, bounds, protection, lane, laneCount, spacing, add, exits);
      }
      if (!list.some(isClear)) pcbFallback(connection, unrelated, bounds, protection, add);
    }
    if (protection) {
      if (list.filter(isClear).length < 3) protectedCandidates(connection, protection, bounds, list, add);
      addLaneAlternatives(list, add, laneSeedLimit);
    }
    return orderedCandidates();
  }

  function parallelCost(a, b, dx, dy, sin, spacing, pcb) {
    const along = dx * a.ux + dy * a.uy;
    const cosine = a.ux * b.ux + a.uy * b.uy;
    const end = along + b.length * cosine;
    let from = Math.max(0, Math.min(along, end));
    let to = Math.min(a.length, Math.max(along, end));
    if (to <= from) return 0;
    const perpendicular = cross(a.ux, a.uy, dx, dy);
    const gradient = sin / cosine;
    if (Math.abs(gradient) > EPSILON) {
      const enters = along + (-spacing - perpendicular) / gradient;
      const exits = along + (spacing - perpendicular) / gradient;
      from = Math.max(from, Math.min(enters, exits));
      to = Math.min(to, Math.max(enters, exits));
      if (to <= from) return 0;
    } else if (Math.abs(perpendicular) >= spacing) {
      return 0;
    }
    const separation = Math.abs(perpendicular + ((from + to) / 2 - along) * gradient);
    const closeness = 1 - separation / spacing;
    const weight = pcb ? .25 + 3.65 * closeness * closeness : .3 + 2.3 * closeness;
    // Coincident strokes can make two patch leads look like one.
    const mergedStroke = spacing > (pcb ? PCB_SPACING : WIRE_SPACING) ?
      8 * Math.max(0, 1 - separation / (spacing / 2)) ** 2 : 0;
    return (to - from) * (weight + mergedStroke);
  }

  function isEndpoint(segment, at) {
    return (segment.first && at < EPSILON) || (segment.last && segment.length - at < EPSILON);
  }

  function near(a, b, spacing) {
    return a.right + spacing >= b.left && b.right + spacing >= a.left &&
      a.bottom + spacing >= b.top && b.bottom + spacing >= a.top;
  }

  function pairCost(first, second, budget, pcb, spacing) {
    const reach = Math.max(WIRE_SPACING, spacing.x, spacing.y);
    if (!near(first.box, second.box, reach)) return 0;
    let cost = 0;
    let intersections;
    for (const a of first.segments) {
      for (const b of second.segments) {
        if (!near(a, b, reach)) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const sin = cross(a.ux, a.uy, b.ux, b.uy);
        const angle = Math.abs(sin);
        if (angle < .3) {
          const pitch = Math.abs(a.uy) < .15 && Math.abs(b.uy) < .15 ? spacing.y : spacing.x;
          // Average both projections so the cost is independent of route evaluation order.
          const penalty = (parallelCost(a, b, dx, dy, sin, pitch, pcb) +
            parallelCost(b, a, -dx, -dy, -sin, pitch, pcb)) / 2;
          cost += pcb ? 3 * penalty : penalty;
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
              cost += pcb ? 45 + 55 * (1 - angle) : 29 + 13 * (1 - angle);
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

  function choose(entry, entries, index, candidateLimit, pcb, spacing) {
    let best = null;
    let bestScore = Infinity;
    const leastObstruction = entry.candidates[0].obstruction;
    for (let i = 0; i < Math.min(entry.candidates.length, candidateLimit); i++) {
      const candidate = entry.candidates[i];
      if (compareObstruction(candidate.obstruction, leastObstruction) || candidate.base >= bestScore) break;
      let score = candidate.base;
      const addCost = (other) => {
        if (entry !== other && other.route) score += pairCost(candidate, other.route, bestScore - score, pcb, spacing);
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

  function routeCables(connections, obstacles, bounds, protectedAreas = [],
    {strategy, spacing, horizontalSpacing, deviceClearance = 0} = {}) {
    const pcb = strategy === "pcb";
    const defaultSpacing = pcb ? PCB_SPACING : WIRE_SPACING;
    const wireSpacing = clamp(Number.isFinite(spacing) ? spacing : defaultSpacing, 1, WIRE_CELL_SIZE);
    const trackSpacing = {
      x: wireSpacing,
      y: Number.isFinite(horizontalSpacing) ? clamp(horizontalSpacing, wireSpacing, WIRE_CELL_SIZE) : wireSpacing,
    };
    const clearance = clamp(Number.isFinite(deviceClearance) ? deviceClearance : 0, 0, WIRE_CELL_SIZE);
    const protection = protectionIndex([...protectedAreas].sort(orderAreas), bounds);
    const deviceBoxes = [...obstacles].sort(orderAreas);
    const rows = visibleOuterRows(deviceBoxes, protection);
    const routingBoxes = clearance ? deviceBoxes.map(box => ({...box,
      left: box.left - clearance, right: box.right + clearance,
      top: box.top - clearance, bottom: box.bottom + clearance,
    })) : deviceBoxes;
    const laneSeedLimit = connections.length > 128 ? 1 : 2;
    const ordered = pcb || clearance ? [...connections].sort((a, b) =>
      a.a.x + a.b.x - b.a.x - b.b.x || a.a.y + a.b.y - b.a.y - b.b.y || orderKey(a.id, b.id)) : connections;
    const entries = ordered.map((connection, lane) => ({
      id: connection.id,
      length: distance(connection.a, connection.b),
      candidates: candidates(connection, deviceBoxes, routingBoxes, bounds, protection, rows, laneSeedLimit, pcb, lane,
        ordered.length, trackSpacing),
      route: null,
    })).sort((a, b) => {
      return a.length - b.length || orderKey(a.id, b.id);
    });

    const index = entries.length > 96 ? wireIndex(entries, bounds) : null;
    const candidateLimit = entries.length > 256 ? 14 : entries.length > 128 ? 22 : clearance ? 140 : pcb ? 80 : Infinity;
    entries.forEach((entry, i) => { entry.index = i; });
    function place(entry) {
      const route = choose(entry, entries, index, candidateLimit, pcb, trackSpacing);
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

  globalThis.NbCableEditorRouting = {routeCables};
})();
