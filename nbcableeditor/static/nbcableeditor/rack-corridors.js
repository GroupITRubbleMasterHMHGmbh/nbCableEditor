(() => {
  "use strict";

  const MAX_AXIS_POINTS = 88;
  const MAX_EXPANSIONS = 1200;
  const MAX_CANDIDATES = 3;
  const BEND_COST = 4;

  function endpointExits(endpoint, areas, clearSegment) {
    let {x: left, x: right, y: top, y: bottom} = endpoint;
    for (const area of areas) {
      if (area.kind !== "port" || endpoint.port === undefined || area.port !== endpoint.port) continue;
      left = Math.min(left, area.left);
      right = Math.max(right, area.right);
      top = Math.min(top, area.top);
      bottom = Math.max(bottom, area.bottom);
    }
    if (left === right && top === bottom) return [endpoint];

    // Cardinal exits find a gap alongside the port. Corners can escape a staggered row
    // even if each adjacent cardinal exit is blocked by another port or label.
    return [
      {x: left, y: endpoint.y}, {x: right, y: endpoint.y},
      {x: endpoint.x, y: top}, {x: endpoint.x, y: bottom},
      {x: left, y: top}, {x: right, y: top}, {x: left, y: bottom}, {x: right, y: bottom},
    ].filter((point) => clearSegment(endpoint, point));
  }

  function axisPoints(start, end, limit, exits, areas, axis, from, to) {
    const required = new Set([limit[from], limit[to], start[axis], end[axis], (start[axis] + end[axis]) / 2]);
    for (const point of exits) required.add(point[axis]);
    // Keep the center of clear rack corridors even when many port edges must be sampled.
    const gaps = [];
    let occupied = limit[from];
    for (const area of [...areas].sort((a, b) => a[from] - b[from])) {
      if (area[from] > occupied) gaps.push([occupied, area[from]]);
      occupied = Math.max(occupied, area[to]);
    }
    if (occupied < limit[to]) gaps.push([occupied, limit[to]]);
    gaps.sort(([a, b], [c, d]) => (d - c) - (b - a));
    for (const [a, b] of gaps.slice(0, 6)) required.add((a + b) / 2);

    const extra = new Set();
    for (const area of areas) {
      for (const edge of [area[from], area[to]]) {
        if (edge > limit[from] && edge < limit[to] && !required.has(edge)) extra.add(edge);
      }
    }

    const coordinates = [...extra];
    const available = MAX_AXIS_POINTS - required.size;
    if (coordinates.length <= available) return [...required, ...coordinates].sort((a, b) => a - b);

    // Retain nearby port geometry first and sample the intervening rails across the board.
    const distanceToEndpoint = (value) => Math.min(Math.abs(value - start[axis]), Math.abs(value - end[axis]));
    coordinates.sort((a, b) => distanceToEndpoint(a) - distanceToEndpoint(b) || a - b);
    const near = coordinates.splice(0, Math.floor(available * 0.6));
    coordinates.sort((a, b) => a - b);
    const remaining = available - near.length;
    for (let i = 0; i < remaining; i++) {
      near.push(coordinates[Math.floor((i + 0.5) * coordinates.length / remaining)]);
    }
    return [...required, ...near].sort((a, b) => a - b);
  }

  function boundary(values, target, upper = false) {
    let left = 0;
    let right = values.length;
    while (left < right) {
      const middle = (left + right) >> 1;
      if (values[middle] < target || (upper && values[middle] === target)) left = middle + 1;
      else right = middle;
    }
    return left;
  }

  function blockedEdges(xs, ys, areas) {
    const columns = xs.length + 1;
    const rows = ys.length + 1;
    const horizontal = new Int32Array(columns * rows);
    const vertical = new Int32Array(columns * rows);

    function mark(grid, left, top, right, bottom) {
      if (left >= right || top >= bottom) return;
      grid[top * columns + left]++;
      grid[top * columns + right]--;
      grid[bottom * columns + left]--;
      grid[bottom * columns + right]++;
    }

    for (const area of areas) {
      const left = boundary(xs, area.left, true);
      const right = boundary(xs, area.right);
      const top = boundary(ys, area.top, true);
      const bottom = boundary(ys, area.bottom);
      // Edges overlap the rectangle on one axis and lie strictly within it on the other.
      mark(horizontal, Math.max(0, left - 1), top, Math.min(xs.length - 1, right), bottom);
      mark(vertical, left, Math.max(0, top - 1), right, Math.min(ys.length - 1, bottom));
    }

    for (const grid of [horizontal, vertical]) {
      for (let y = 0; y < ys.length; y++) {
        let row = 0;
        for (let x = 0; x < xs.length; x++) {
          const at = y * columns + x;
          row += grid[at];
          grid[at] = row + (y ? grid[at - columns] : 0);
        }
      }
    }
    return {horizontal, vertical, columns};
  }

  class Queue {
    items = [];

    static before(a, b) {
      return a.total < b.total || (a.total === b.total && a.remaining < b.remaining);
    }

    push(item) {
      const {items} = this;
      let index = items.length;
      items.push(item);
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (!Queue.before(item, items[parent])) break;
        items[index] = items[parent];
        index = parent;
      }
      items[index] = item;
    }

    pop() {
      const {items} = this;
      const first = items[0];
      const last = items.pop();
      if (!items.length) return first;
      let index = 0;
      while (index * 2 + 1 < items.length) {
        let child = index * 2 + 1;
        if (child + 1 < items.length && Queue.before(items[child + 1], items[child])) child++;
        if (!Queue.before(items[child], last)) break;
        items[index] = items[child];
        index = child;
      }
      items[index] = last;
      return first;
    }
  }

  function direction(a, b) {
    if (a.x === b.x && a.y !== b.y) return 2;
    if (a.y === b.y && a.x !== b.x) return 1;
    return 0;
  }

  function compact(points) {
    const result = [];
    for (const point of points) {
      const last = result.at(-1);
      if (last && last.x === point.x && last.y === point.y) continue;
      const previous = result.at(-2);
      if (previous && (
        (previous.x === last.x && last.x === point.x && (last.y - previous.y) * (point.y - last.y) > 0) ||
        (previous.y === last.y && last.y === point.y && (last.x - previous.x) * (point.x - last.x) > 0)
      )) result.pop();
      result.push(point);
    }
    result[0] = points[0];
    result[result.length - 1] = points.at(-1);
    return result;
  }

  function railBridges(a, b, starts, ends, xs, ys, edges, accept) {
    const {horizontal, vertical, columns} = edges;
    const rowStart = new Uint8Array(columns * ys.length);
    const columnStart = new Uint8Array(rowStart.length);
    for (let y = 0; y < ys.length; y++) {
      for (let x = 0; x < xs.length; x++) {
        const at = y * columns + x;
        rowStart[at] = x && !horizontal[at - 1] ? rowStart[at - 1] : x;
        columnStart[at] = y && !vertical[at - columns] ? columnStart[at - columns] : y;
      }
    }
    const across = (x, other, y) =>
      rowStart[y * columns + Math.max(x, other)] <= Math.min(x, other);
    const down = (y, other, x) =>
      columnStart[Math.max(y, other) * columns + x] <= Math.min(y, other);
    const terminal = (point, endpoint) => ({
      point, x: boundary(xs, point.x), y: boundary(ys, point.y),
      length: Math.hypot(point.x - endpoint.x, point.y - endpoint.y),
    });
    const sources = starts.map((point) => terminal(point, a));
    const targets = ends.map((point) => terminal(point, b));
    const byX = new Array(xs.length);
    const byY = new Array(ys.length);
    for (const from of sources) {
      for (const to of targets) {
        const terminals = from.length + to.length;
        const width = Math.abs(from.point.x - to.point.x);
        const height = Math.abs(from.point.y - to.point.y);
        for (let x = 0; x < xs.length; x++) {
          const rail = xs[x];
          const cost = terminals + height + Math.abs(rail - from.point.x) + Math.abs(rail - to.point.x);
          if (cost >= (byX[x]?.cost ?? Infinity) || !across(from.x, x, from.y) ||
              !across(to.x, x, to.y) || !down(from.y, to.y, x)) continue;
          byX[x] = {cost, from, to, first: {x: rail, y: from.point.y}, last: {x: rail, y: to.point.y}};
        }
        for (let y = 0; y < ys.length; y++) {
          const rail = ys[y];
          const cost = terminals + width + Math.abs(rail - from.point.y) + Math.abs(rail - to.point.y);
          if (cost >= (byY[y]?.cost ?? Infinity) || !down(from.y, y, from.x) ||
              !down(to.y, y, to.x) || !across(from.x, to.x, y)) continue;
          byY[y] = {cost, from, to, first: {x: from.point.x, y: rail}, last: {x: to.point.x, y: rail}};
        }
      }
    }
    let count = 0;
    const best = [...byX, ...byY].filter(Boolean).sort((p, q) => p.cost - q.cost).slice(0, 16);
    for (const {from, to, first, last} of best) {
      if (accept([a, from.point, first, last, to.point, b]) && ++count >= MAX_CANDIDATES) return;
    }
  }

  function candidates(connection, protectedAreas, bounds, clearSegment) {
    const {a, b} = connection;
    if (a.x === b.x && a.y === b.y) return [];
    const marginX = Math.max(96, Math.min(180, bounds.width / 3));
    const limit = {
      left: Math.max(0, Math.min(a.x, b.x) - marginX),
      right: Math.min(bounds.width, Math.max(a.x, b.x) + marginX),
      top: Math.max(0, Math.min(a.y, b.y) - 88),
      bottom: Math.min(bounds.height, Math.max(a.y, b.y) + 88),
    };
    const areas = protectedAreas.filter((area) =>
      area.left < area.right && area.top < area.bottom &&
      area.left < limit.right && area.right > limit.left &&
      area.top < limit.bottom && area.bottom > limit.top
    );
    const insideLimit = (p) => p.x >= limit.left && p.x <= limit.right && p.y >= limit.top && p.y <= limit.bottom;
    const starts = endpointExits(a, areas, clearSegment).filter(insideLimit);
    const ends = endpointExits(b, areas, clearSegment).filter(insideLimit);
    if (!starts.length || !ends.length) return [];

    const exits = [...starts, ...ends];
    const xs = axisPoints(a, b, limit, exits, areas, "x", "left", "right");
    const ys = axisPoints(a, b, limit, exits, areas, "y", "top", "bottom");
    const stride = xs.length;
    const pointIndex = (p) => boundary(ys, p.y) * stride + boundary(xs, p.x);
    const goals = new Map(ends.map((p) => [pointIndex(p), p]));
    const edges = blockedEdges(xs, ys, areas);
    const {horizontal, vertical, columns} = edges;
    const routes = [];
    const seen = new Set();
    function accept(raw) {
      const points = compact(raw);
      const signature = points.map((p) => p.x + "," + p.y).join("/");
      if (seen.has(signature) || !points.every((point, i) => i === 0 || clearSegment(points[i - 1], point))) {
        return false;
      }
      seen.add(signature);
      routes.push(points);
      return true;
    }

    // Across several populated rows, try reaching the destination along a free side rail.
    const longRun = areas.length > 192 && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 240;
    if (longRun) {
      railBridges(a, b, starts, ends, xs, ys, edges, accept);
      if (routes.length) return routes;
    }

    const costs = new Float64Array(xs.length * ys.length * 3).fill(Infinity);
    const parents = new Int32Array(costs.length).fill(-1);
    const queue = new Queue();

    // The final escape can be diagonal. Discount that shortcut in the Manhattan estimate.
    const shortcut = Math.max(...ends.map((p) => {
      const dx = Math.abs(p.x - b.x);
      const dy = Math.abs(p.y - b.y);
      return dx + dy - Math.hypot(dx, dy);
    }));

    function visit(x, y, axis, cost, parent) {
      const state = (y * stride + x) * 3 + axis;
      if (cost >= costs[state]) return;
      costs[state] = cost;
      parents[state] = parent;
      const remaining = Math.max(0, Math.abs(xs[x] - b.x) + Math.abs(ys[y] - b.y) - shortcut);
      queue.push({state, cost, remaining, total: cost + remaining});
    }

    for (const point of starts) {
      visit(boundary(xs, point.x), boundary(ys, point.y), direction(a, point),
        Math.hypot(point.x - a.x, point.y - a.y), -1);
    }

    const acceptedEnds = new Set();
    let best = Infinity;
    let expansions = 0;
    while (queue.items.length && expansions < MAX_EXPANSIONS && routes.length < MAX_CANDIDATES) {
      const current = queue.pop();
      if (current.cost !== costs[current.state]) continue;
      if (current.total > best + 24) break;
      expansions++;
      const node = Math.floor(current.state / 3);
      const axis = current.state % 3;
      const x = node % stride;
      const y = Math.floor(node / stride);
      const index = y * columns + x;
      const goal = goals.get(node);
      if (goal && !acceptedEnds.has(node)) {
        const reversed = [];
        for (let state = current.state; state >= 0; state = parents[state]) {
          const index = Math.floor(state / 3);
          reversed.push({x: xs[index % stride], y: ys[Math.floor(index / stride)]});
        }
        if (accept([a, ...reversed.reverse(), b])) {
          const arrival = direction(goal, b);
          best = Math.min(best, current.cost + Math.hypot(goal.x - b.x, goal.y - b.y) +
            (axis && arrival && axis !== arrival ? BEND_COST : 0));
          acceptedEnds.add(node);
        }
      }

      const horizontalCost = current.cost + (axis === 2 ? BEND_COST : 0);
      const verticalCost = current.cost + (axis === 1 ? BEND_COST : 0);
      if (x > 0 && !horizontal[index - 1]) {
        visit(x - 1, y, 1, horizontalCost + xs[x] - xs[x - 1], current.state);
      }
      if (x + 1 < xs.length && !horizontal[index]) {
        visit(x + 1, y, 1, horizontalCost + xs[x + 1] - xs[x], current.state);
      }
      if (y > 0 && !vertical[index - columns]) {
        visit(x, y - 1, 2, verticalCost + ys[y] - ys[y - 1], current.state);
      }
      if (y + 1 < ys.length && !vertical[index]) {
        visit(x, y + 1, 2, verticalCost + ys[y + 1] - ys[y], current.state);
      }
    }
    // A path across a tall rack can consume the search budget exploring individual rows.
    // Try two terminal runs and a shared, clear side rail directly in that case.
    if (!longRun && !routes.length) railBridges(a, b, starts, ends, xs, ys, edges, accept);
    return routes;
  }

  globalThis.NbCableEditorCorridors = {candidates};
})();
