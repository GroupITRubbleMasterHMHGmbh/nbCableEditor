(() => {
  "use strict";

  const MAX_RADIUS = 18;
  const STROKE_CLEARANCE = 1;

  function mix(a, b, t) {
    return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
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

  function roundCorner(before, corner, after, obstacles) {
    const inX = before.x - corner.x;
    const inY = before.y - corner.y;
    const outX = after.x - corner.x;
    const outY = after.y - corner.y;
    const incoming = Math.hypot(inX, inY);
    const outgoing = Math.hypot(outX, outY);
    if (Math.abs(inX * outY - inY * outX) < .01 * incoming * outgoing) return null;

    // Leave part of each straight segment visible, even when its other end is rounded as well.
    for (let radius = Math.min(MAX_RADIUS, .42 * incoming, .42 * outgoing); radius >= 1.5; radius /= 2) {
      const start = mix(corner, before, radius / incoming);
      const end = mix(corner, after, radius / outgoing);
      const samples = [start];
      if (sampleCurve(start, corner, end, obstacles, samples, 3)) return {start, end, samples};
    }
    return null;
  }

  function roundPath(points, obstacles) {
    const coordinate = ({x, y}) => x + " " + y;
    const first = points[0];
    const commands = ["M " + coordinate(first)];
    const samples = [first];
    for (let i = 1; i < points.length - 1; i++) {
      const corner = points[i];
      const turn = roundCorner(points[i - 1], corner, points[i + 1], obstacles);
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

  globalThis.NetBoxRackCablePath = {roundPath};
})();
