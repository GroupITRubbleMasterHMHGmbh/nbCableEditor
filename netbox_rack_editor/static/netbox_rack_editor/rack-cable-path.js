(() => {
  "use strict";

  const MAX_RADIUS = 18;
  const STROKE_CLEARANCE = 1;
  const PORT_LEAD = 10;
  const PORT_JOIN_LIMIT = 32;

  function mix(a, b, t) {
    return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
  }

  function intersects(a, b, rect) {
    let entry = 0;
    let exit = 1;
    for (const [axis, low, high] of [["x", rect.left, rect.right], ["y", rect.top, rect.bottom]]) {
      const delta = b[axis] - a[axis];
      if (!delta) {
        if (a[axis] <= low || a[axis] >= high) return false;
        continue;
      }
      const start = (low - a[axis]) / delta;
      const end = (high - a[axis]) / delta;
      entry = Math.max(entry, Math.min(start, end));
      exit = Math.min(exit, Math.max(start, end));
    }
    return entry < exit;
  }

  function terminalJoins(points, index, crossing) {
    const joins = [];
    let travelled = 0;
    let previous = crossing;
    for (let i = index; i < points.length && travelled < PORT_JOIN_LIMIT; i++) {
      const point = points[i];
      const length = Math.hypot(point.x - previous.x, point.y - previous.y);
      if (!length) continue;
      const end = Math.min(PORT_JOIN_LIMIT, travelled + length);
      for (const distance of [8, 16, 24]) {
        if (distance > travelled && distance < end) {
          joins.push({point: mix(previous, point, (distance - travelled) / length), next: i});
        }
      }
      const fraction = (end - travelled) / length;
      joins.push(fraction < 1 ? {point: mix(previous, point, fraction), next: i} : {point, next: i + 1});
      travelled = end;
      previous = point;
    }
    return joins;
  }

  function portSides(rect) {
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    return [
      {axis: "x", direction: -1, anchor: {x: rect.left, y}},
      {axis: "x", direction: 1, anchor: {x: rect.right, y}},
      {axis: "y", direction: -1, anchor: {x, y: rect.top}},
      {axis: "y", direction: 1, anchor: {x, y: rect.bottom}},
    ];
  }

  function attachPort(points, rect, protectedAreas, preserveAligned) {
    if (!rect) return points;
    const index = points.findIndex(({x, y}, i) => i > 0 &&
      (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom));
    if (index < 1) return points;

    const before = points[index - 1];
    const after = points[index];
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const xEdge = dx > 0 ? rect.right : rect.left;
    const yEdge = dy > 0 ? rect.bottom : rect.top;
    const tx = dx ? (xEdge - before.x) / dx : Infinity;
    const ty = dy ? (yEdge - before.y) / dy : Infinity;
    const firstAxis = tx <= ty ? "x" : "y";
    const firstDirection = Math.sign(firstAxis === "x" ? dx : dy);
    const sides = portSides(rect);
    const first = sides.find(side => side.axis === firstAxis && side.direction === firstDirection);
    const crossAxis = firstAxis === "x" ? "y" : "x";
    const rest = points.slice(index);
    const aligned = before[crossAxis] === first.anchor[crossAxis] && after[crossAxis] === first.anchor[crossAxis];
    if (aligned && (preserveAligned || Math.abs(after[firstAxis] - first.anchor[firstAxis]) >= PORT_LEAD)) {
      return [first.anchor, ...rest];
    }

    // A short diagonal escape can be followed by a much longer straight run. Rejoin it
    // locally, after the connector lead, and keep the rest of the chosen route intact.
    const crossing = mix(before, after, Math.min(tx, ty));
    const joins = terminalJoins(points, index, crossing);
    const neighbors = protectedAreas.filter(area => (rect.port === undefined || area.port !== rect.port) &&
      area.left < rect.right + PORT_JOIN_LIMIT && area.right > rect.left - PORT_JOIN_LIMIT &&
      area.top < rect.bottom + PORT_JOIN_LIMIT && area.bottom > rect.top - PORT_JOIN_LIMIT);
    const orderedSides = [first, ...sides.filter(side => side !== first)];
    for (const distance of [PORT_LEAD + 2, PORT_LEAD, 6, 3, 1]) {
      for (const {axis, direction, anchor} of orderedSides) {
        const lead = {...anchor, [axis]: anchor[axis] + direction * distance};
        if (neighbors.some(area => intersects(anchor, lead, area))) continue;
        for (const {point, next} of joins) {
          if ((point[axis] - lead[axis]) * direction < 0 || neighbors.some(area => intersects(lead, point, area))) continue;
          const cross = axis === "x" ? "y" : "x";
          const stem = point[cross] === lead[cross] ? [] : [lead];
          return [anchor, ...stem, point, ...points.slice(next)];
        }
      }
    }
    return aligned ? [first.anchor, ...rest] : [first.anchor, crossing, ...rest];
  }

  function raiseShallowReturn(points, from, to, protectedAreas, bounds) {
    const start = points[0];
    const end = points.at(-1);
    const sideAt = (rect, point) => portSides(rect).find(({anchor}) => anchor.x === point.x && anchor.y === point.y);
    const first = sideAt(from, start);
    const last = sideAt(to, end);
    if (!first || !last || first.axis !== last.axis || first.direction !== last.direction) return points;
    const {axis, direction} = first;
    const cross = axis === "x" ? "y" : "x";
    const low = Math.min(start[cross], end[cross]);
    const high = Math.max(start[cross], end[cross]);
    const outer = Math.max(start[axis] * direction, end[axis] * direction);
    if (high - low > 2 * PORT_JOIN_LIMIT || points.some(point =>
      point[cross] < low || point[cross] > high || point[axis] * direction > outer + PORT_LEAD)) return points;

    // A short loop between ports on the same edge may never reach the desired lead length.
    // Move just its crossbar outward, provided the slightly taller loop is still clear.
    const obstacles = protectedAreas.filter(area => area.port === undefined || (area.port !== from.port && area.port !== to.port));
    for (const distance of [PORT_LEAD + 2, PORT_LEAD]) {
      const rail = (outer + distance) * direction;
      const limit = axis === "x" ? bounds?.width : bounds?.height;
      if (rail < 0 || (limit !== undefined && rail > limit)) continue;
      const leadA = {...start, [axis]: rail};
      const leadB = {...end, [axis]: rail};
      if (!obstacles.some(area => intersects(start, leadA, area) || intersects(leadA, leadB, area) || intersects(leadB, end, area))) {
        return [start, leadA, leadB, end];
      }
    }
    return points;
  }

  function anchorPorts(points, from, to, protectedAreas = [], {preserveAligned = false, bounds} = {}) {
    const anchored = attachPort(points, from, protectedAreas, preserveAligned);
    if (!to) return anchored;
    const both = attachPort(anchored.slice().reverse(), to, protectedAreas, preserveAligned).reverse();
    return from && !preserveAligned ? raiseShallowReturn(both, from, to, protectedAreas, bounds) : both;
  }

  function overlapsHull(a, b, c, box) {
    return Math.min(a.x, b.x, c.x) < box.right + STROKE_CLEARANCE &&
      Math.max(a.x, b.x, c.x) > box.left - STROKE_CLEARANCE &&
      Math.min(a.y, b.y, c.y) < box.bottom + STROKE_CLEARANCE &&
      Math.max(a.y, b.y, c.y) > box.top - STROKE_CLEARANCE;
  }

  function sampleCurve(a, b, c, obstacles, samples, depth) {
    // A quadratic stays inside the hull of its control points. Subdivide for a tighter check.
    const nearby = obstacles.filter(box => overlapsHull(a, b, c, box));
    if (depth === 0) {
      if (nearby.length) return false;
      samples.push(c);
      return true;
    }
    const left = mix(a, b, .5);
    const right = mix(b, c, .5);
    const middle = mix(left, right, .5);
    return sampleCurve(a, left, middle, nearby, samples, depth - 1) &&
      sampleCurve(middle, right, c, nearby, samples, depth - 1);
  }

  function roundCorner(before, corner, after, obstacles, maxRadius) {
    const inX = before.x - corner.x;
    const inY = before.y - corner.y;
    const outX = after.x - corner.x;
    const outY = after.y - corner.y;
    const incoming = Math.hypot(inX, inY);
    const outgoing = Math.hypot(outX, outY);
    if (Math.abs(inX * outY - inY * outX) < .01 * incoming * outgoing) return null;

    // Leave part of each straight segment visible, even when its other end is rounded as well.
    for (let radius = Math.min(maxRadius, .42 * incoming, .42 * outgoing); radius >= 1.5; radius /= 2) {
      const start = mix(corner, before, radius / incoming);
      const end = mix(corner, after, radius / outgoing);
      const samples = [start];
      if (sampleCurve(start, corner, end, obstacles, samples, 3)) return {start, end, samples};
    }
    return null;
  }

  function roundPath(points, obstacles, maxRadius = MAX_RADIUS, preservePortLead = false) {
    const coordinate = ({x, y}) => x + " " + y;
    const first = points[0];
    const commands = ["M " + coordinate(first)];
    const samples = [first];
    for (let i = 1; i < points.length - 1; i++) {
      const corner = points[i];
      let radius = maxRadius;
      if (preservePortLead && i === 1) radius = Math.min(radius, Math.hypot(corner.x - first.x, corner.y - first.y) - PORT_LEAD);
      if (preservePortLead && i === points.length - 2) {
        const last = points.at(-1);
        radius = Math.min(radius, Math.hypot(corner.x - last.x, corner.y - last.y) - PORT_LEAD);
      }
      const turn = roundCorner(points[i - 1], corner, points[i + 1], obstacles, radius);
      if (turn) {
        commands.push("L " + coordinate(turn.start), "Q " + coordinate(corner) + " " + coordinate(turn.end));
        samples.push(...turn.samples);
      } else {
        commands.push("L " + coordinate(corner));
        samples.push(corner);
      }
    }
    const last = points.at(-1);
    commands.push("L " + coordinate(last));
    samples.push(last);
    return {d: commands.join(" "), points: samples};
  }

  globalThis.NetBoxRackCablePath = {anchorPorts, roundPath};
})();
