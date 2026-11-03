(() => {
  "use strict";

  const EPSILON = 1e-7;
  const CLEARANCE = 24;
  const SWEEP_MARGIN = .5;
  const CONNECTOR_GAP = 2;

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function interpolate(a, b, t) {
    return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
  }

  function clipAxis(start, delta, min, max, interval) {
    if (delta === 0) return start >= min && start <= max;
    const a = (min - start) / delta;
    const b = (max - start) / delta;
    interval.from = Math.max(interval.from, Math.min(a, b));
    interval.to = Math.min(interval.to, Math.max(a, b));
    return interval.from <= interval.to;
  }

  function clipSegment(a, b, rect) {
    const interval = {from: 0, to: 1};
    return clipAxis(a.x, b.x - a.x, rect.left, rect.right, interval) &&
      clipAxis(a.y, b.y - a.y, rect.top, rect.bottom, interval) ? interval : null;
  }

  function visibleSegments(points, clip) {
    const segments = [];
    if (clip.right <= clip.left || clip.bottom <= clip.top) return segments;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (a.x === b.x && a.y === b.y) continue;
      const interval = clipSegment(a, b, clip);
      if (interval && interval.to > interval.from) {
        segments.push({a: interpolate(a, b, interval.from), b: interpolate(a, b, interval.to)});
      }
    }
    return segments;
  }

  function nearestPoint(segments, point) {
    let closest = null;
    let best = Infinity;
    for (const {a, b} of segments) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const squareLength = dx * dx + dy * dy;
      const t = squareLength ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / squareLength, 0, 1) : 0;
      const projection = interpolate(a, b, t);
      const distance = (point.x - projection.x) ** 2 + (point.y - projection.y) ** 2;
      if (distance < best) {
        closest = projection;
        best = distance;
      }
    }
    return closest;
  }

  function overlaps(a, b) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  }

  function rectFor(a, b) {
    return {
      left: Math.min(a.x, b.x), right: Math.max(a.x, b.x),
      top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y),
    };
  }

  function blocksTooltip(segment, rect) {
    return overlaps(segment, rect) && clipSegment(segment.a, segment.b, rect) !== null;
  }

  function crossesConnector(anchor, edge, segments) {
    const dx = edge.x - anchor.x;
    const dy = edge.y - anchor.y;
    const length = Math.hypot(dx, dy);
    if (length <= CONNECTOR_GAP) return false;
    const box = rectFor(anchor, edge);
    for (const segment of segments) {
      if (!overlaps(segment, box)) continue;
      const cross = dx * segment.dy - dy * segment.dx;
      if (Math.abs(cross) < EPSILON) continue;
      const x = segment.a.x - anchor.x;
      const y = segment.a.y - anchor.y;
      const at = (x * segment.dy - y * segment.dx) / cross;
      const onWire = (x * dy - y * dx) / cross;
      if (at * length > CONNECTOR_GAP && at < 1 && onWire >= 0 && onWire <= 1) return true;
    }
    return false;
  }

  function sweepPositions(axis, center, length, low, high, previous, segments) {
    const choices = new Set();
    function add(position) {
      if (Number.isFinite(position)) choices.add(clamp(position, low, high));
    }
    add(previous);
    add(center - length / 2);
    add(center - length / 4);
    add(center - length * .75);
    for (const offset of [CLEARANCE + 1, 30, 68]) {
      add(center + offset);
      add(center - length - offset);
    }
    add(low);
    add(high);
    add((low + high) / 2);

    const endpoints = new Set();
    for (const {a, b} of segments) {
      endpoints.add(a[axis]);
      endpoints.add(b[axis]);
    }
    const near = Array.from(endpoints).sort((a, b) => Math.abs(center - a) - Math.abs(center - b) || a - b);
    for (const value of near.slice(0, 6)) {
      add(value + CLEARANCE + SWEEP_MARGIN);
      add(value - length - CLEARANCE - SWEEP_MARGIN);
    }
    return choices;
  }

  function sweep(axis, position, size, otherSize, low, high, center, previous, segments, consider) {
    const otherAxis = axis === "x" ? "y" : "x";
    const gap = CLEARANCE + SWEEP_MARGIN;
    const forbidden = [];
    for (const {a, b, dx, dy} of segments) {
      const interval = {from: 0, to: 1};
      const along = axis === "x" ? dx : dy;
      if (!clipAxis(a[axis], along, position - gap, position + size + gap, interval)) continue;
      const across = axis === "x" ? dy : dx;
      const atStart = a[otherAxis] + across * interval.from;
      const atEnd = a[otherAxis] + across * interval.to;
      const from = Math.min(atStart, atEnd) - otherSize - gap;
      const to = Math.max(atStart, atEnd) + gap;
      if (to >= low && from <= high) forbidden.push([from, to]);
    }
    forbidden.sort((a, b) => a[0] - b[0]);

    function tryGap(from, to) {
      const centered = clamp(center - otherSize / 2, from, to);
      if (axis === "x") consider(position, centered);
      else consider(centered, position);
      if (!Number.isFinite(previous)) return;
      const stable = clamp(previous, from, to);
      if (stable === centered) return;
      if (axis === "x") consider(position, stable);
      else consider(stable, position);
    }

    // Project each segment onto the remaining axis. The gaps are exactly the
    // places where this fixed-width or fixed-height strip can fit a tooltip.
    let next = low;
    for (const [from, to] of forbidden) {
      if (from > next) tryGap(next, from);
      next = Math.max(next, to);
      if (next > high) return;
    }
    tryGap(next, high);
  }

  function place({anchor, width, height, bounds, segments, previous}) {
    const maxLeft = bounds.right - width;
    const maxTop = bounds.bottom - height;
    if (!(width > 0 && height > 0) || maxLeft < bounds.left || maxTop < bounds.top) return null;

    const paths = segments.map(({a, b}) => ({a, b, dx: b.x - a.x, dy: b.y - a.y, ...rectFor(a, b)}));
    // Keep the anchor and room for the leader outside the tooltip even when no
    // visible segment occupies its exact coordinates.
    const obstacles = [...paths, {a: anchor, b: anchor, dx: 0, dy: 0, ...rectFor(anchor, anchor)}];
    let best = null;
    let bestScore = Infinity;
    let bestDistance = Infinity;
    const tried = new Set();

    function consider(left, top) {
      if (left < bounds.left || left > maxLeft || top < bounds.top || top > maxTop) return;
      const key = left + ":" + top;
      if (tried.has(key)) return;
      tried.add(key);
      const right = left + width;
      const bottom = top + height;
      const edge = {x: clamp(anchor.x, left, right), y: clamp(anchor.y, top, bottom)};
      const distance = Math.hypot(edge.x - anchor.x, edge.y - anchor.y);
      const centering = Math.hypot(left + width / 2 - anchor.x, top + height / 2 - anchor.y) * .015;
      const movement = previous ? Math.min(18, Math.hypot(left - previous.left, top - previous.top) * .12) : 0;
      const base = distance + centering + movement;
      if (base >= bestScore) return;
      const padded = {left: left - CLEARANCE, top: top - CLEARANCE, right: right + CLEARANCE, bottom: bottom + CLEARANCE};
      if (obstacles.some(segment => blocksTooltip(segment, padded))) return;
      const score = base + (crossesConnector(anchor, edge, paths) ? 20 : 0);
      if (score >= bestScore) return;
      best = {left, top, edge};
      bestScore = score;
      bestDistance = distance;
    }

    const gap = CLEARANCE + 5;
    if (previous) {
      consider(previous.left, previous.top);
      if (best && bestDistance <= gap + 2 && bestScore < gap + 7) return best;
    }

    // In the common case a side or corner next to the anchor is already clear.
    // The strip sweeps are reserved for folds or crowded areas.
    const lefts = [anchor.x - width - gap, anchor.x - width / 2, anchor.x + gap];
    const tops = [anchor.y - height - gap, anchor.y - height / 2, anchor.y + gap];
    for (let x = 0; x < lefts.length; x++) {
      for (let y = 0; y < tops.length; y++) {
        if (x === 1 && y === 1) continue;
        consider(clamp(lefts[x], bounds.left, maxLeft), clamp(tops[y], bounds.top, maxTop));
      }
    }
    if (best && bestDistance <= gap + 2 && bestScore < gap + 8) return best;

    for (const left of sweepPositions("x", anchor.x, width, bounds.left, maxLeft, previous?.left, paths)) {
      sweep("x", left, width, height, bounds.top, maxTop, anchor.y, previous?.top, obstacles, consider);
    }
    for (const top of sweepPositions("y", anchor.y, height, bounds.top, maxTop, previous?.top, paths)) {
      sweep("y", top, height, width, bounds.left, maxLeft, anchor.x, previous?.left, obstacles, consider);
    }
    return best;
  }

  globalThis.NetBoxRackTooltip = {visibleSegments, nearestPoint, place};
})();
