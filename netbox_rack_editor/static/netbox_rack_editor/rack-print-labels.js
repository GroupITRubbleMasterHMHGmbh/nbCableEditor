(() => {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const fontSize = 12;
  const badgeHeight = 17;
  const cellSize = 64;

  function svgElement(document, name, attributes) {
    const element = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  function segment(a, b) {
    return {
      a, b, length: Math.hypot(b.x - a.x, b.y - a.y),
      left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y),
    };
  }

  function segmentsFor(path) {
    // Rack routes use only absolute moves, lines, and quadratic corners.
    const tokens = path.getAttribute("d").match(/[MLQ]|[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi) ?? [];
    const segments = [];
    let previous = null;
    for (let i = 0; i + 2 < tokens.length;) {
      const command = tokens[i++];
      const first = {x: Number(tokens[i++]), y: Number(tokens[i++])};
      if (command === "Q") {
        const end = {x: Number(tokens[i++]), y: Number(tokens[i++])};
        const start = previous;
        for (let step = 1; step <= 6; step++) {
          const t = step / 6;
          const s = 1 - t;
          const point = {x: s * s * start.x + 2 * s * t * first.x + t * t * end.x,
            y: s * s * start.y + 2 * s * t * first.y + t * t * end.y};
          segments.push(segment(previous, point));
          previous = point;
        }
      } else {
        if (command === "L" && previous) segments.push(segment(previous, first));
        previous = first;
      }
    }
    return segments.filter(part => part.length > .01);
  }

  function intersects(a, b) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  }

  function clip(part, box) {
    let start = 0;
    let end = 1;
    for (const [from, to, low, high] of [
      [part.a.x, part.b.x, box.left, box.right], [part.a.y, part.b.y, box.top, box.bottom],
    ]) {
      const delta = to - from;
      if (!delta) {
        if (from < low || from > high) return false;
        continue;
      }
      const entry = (low - from) / delta;
      const exit = (high - from) / delta;
      start = Math.max(start, Math.min(entry, exit));
      end = Math.min(end, Math.max(entry, exit));
      if (start > end) return false;
    }
    return true;
  }

  function indexBoxes() {
    const cells = new Map();
    function* keys(box) {
      for (let y = Math.floor(box.top / cellSize); y <= Math.floor(box.bottom / cellSize); y++) {
        for (let x = Math.floor(box.left / cellSize); x <= Math.floor(box.right / cellSize); x++) {
          yield x + ":" + y;
        }
      }
    }
    return {
      add(box) {
        for (const key of keys(box)) {
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(box);
        }
      },
      find(box) {
        const nearby = new Set();
        for (const key of keys(box)) {
          for (const other of cells.get(key) ?? []) {
            if (intersects(box, other)) nearby.add(other);
          }
        }
        return nearby;
      },
    };
  }

  function anchorAt(parts, distance) {
    for (const part of parts) {
      if (distance <= part.length) {
        const dx = (part.b.x - part.a.x) / part.length;
        const dy = (part.b.y - part.a.y) / part.length;
        return {x: part.a.x + dx * distance, y: part.a.y + dy * distance, nx: -dy, ny: dx};
      }
      distance -= part.length;
    }
    return null;
  }

  function candidate(route, anchor, distance, side, clearance, bounds, blocked, wires) {
    const halfWidth = route.badgeWidth / 2;
    const halfHeight = badgeHeight / 2;
    const reach = Math.abs(anchor.nx) * halfWidth + Math.abs(anchor.ny) * halfHeight;
    const offset = side * (reach + clearance);
    const x = anchor.x + offset * anchor.nx;
    const y = anchor.y + offset * anchor.ny;
    const box = {left: x - halfWidth, top: y - halfHeight, right: x + halfWidth, bottom: y + halfHeight};
    const padded = {left: box.left - 2, top: box.top - 2, right: box.right + 2, bottom: box.bottom + 2};
    if (padded.left < 0 || padded.top < 0 || padded.right > bounds.width ||
        padded.bottom > bounds.height || blocked.find(padded).size) return null;
    const crossing = new Set();
    for (const part of wires.find(padded)) {
      if (part.id !== route.id && clip(part, padded)) crossing.add(part.id);
    }
    return {x, y, anchor, box, padded, side, crossings: crossing.size,
      score: crossing.size * 200 + distance / 4 + (side ? clearance : 3)};
  }

  function bestSpot(route, direction, bounds, blocked, wires, extended = false) {
    const limit = route.length * (extended ? .8 : .48);
    const offsets = extended ? [30, 42, 58, 78, 105, 134, 164, 196] : [18, 28, 38, 50, 65, 82, 104];
    const distances = new Set([...offsets.filter(value => value <= limit), Math.min(limit, 120)]);
    if (extended) distances.add(route.length / 2);
    let best = null;
    for (const distance of distances) {
      const anchor = anchorAt(route.parts, direction === "start" ? distance : route.length - distance);
      if (!anchor) continue;
      for (const [side, clearance] of [[1, 3], [-1, 3], [0, 0], [1, 8], [-1, 8]]) {
        const spot = candidate(route, anchor, distance, side, clearance, bounds, blocked, wires);
        if (spot && (!best || spot.score < best.score)) best = spot;
      }
      // A clear near-end candidate wins over every later candidate with the same offset.
      if (best?.crossings === 0 && best.score <= distance / 4 + 3) break;
    }
    return best && {...best, direction};
  }

  function draw(wires, {width, height, obstacles = [], references}) {
    const document = wires.ownerDocument;
    const bounds = {width, height};
    const blocked = indexBoxes();
    for (const box of obstacles) blocked.add(box);
    const allWires = indexBoxes();
    const routes = [];
    for (const path of wires.querySelectorAll("[data-wire-visual]")) {
      const id = path.getAttribute("data-wire-visual");
      const parts = segmentsFor(path);
      for (const part of parts) allWires.add(Object.assign(part, {id}));
      const ref = references.get(id) ?? references.get(Number(id));
      if (ref == null || !parts.length) continue;
      const label = String(ref);
      routes.push({id, label, parts, length: parts.reduce((sum, part) => sum + part.length, 0),
        badgeWidth: Math.max(19, 8 + label.length * 7)});
    }

    const layer = svgElement(document, "g", {"aria-hidden": "true", "data-print-cable-labels": ""});
    wires.querySelector("[data-print-cable-labels]")?.remove();
    function place(route, spot) {
      const group = svgElement(document, "g", {"data-print-cable-id": route.id, "data-print-cable-ref": route.label});
      if (spot.side) {
        group.append(svgElement(document, "line", {x1: spot.anchor.x, y1: spot.anchor.y, x2: spot.x, y2: spot.y,
          stroke: "#1c2736", "stroke-width": 1.2}));
      }
      group.append(svgElement(document, "rect", {x: spot.box.left, y: spot.box.top, width: route.badgeWidth,
        height: badgeHeight, rx: 4, fill: "#fff", stroke: "#1c2736", "stroke-width": 1.25}));
      const label = svgElement(document, "text", {x: spot.x, y: spot.y + .5, fill: "#1c2736",
        "text-anchor": "middle", "dominant-baseline": "central", "font-family": "system-ui, sans-serif",
        "font-size": fontSize, "font-weight": "700"});
      label.textContent = route.label;
      group.append(label);
      layer.append(group);
      blocked.add(spot.padded);
    }

    const placed = [];
    for (const route of routes) {
      const start = bestSpot(route, "start", bounds, blocked, allWires);
      const end = bestSpot(route, "end", bounds, blocked, allWires);
      let first = [start, end].filter(Boolean).sort((a, b) => a.score - b.score)[0];
      if (!first || first.crossings) {
        const extra = bestSpot(route, "start", bounds, blocked, allWires, true);
        if (extra && (!first || extra.score < first.score)) first = extra;
      }
      if (!first) continue;
      place(route, first);
      placed.push({route, otherEnd: first.direction === "start" ? "end" : "start"});
    }
    for (const {route, otherEnd} of placed) {
      if (route.length < 52) continue;
      const other = bestSpot(route, otherEnd, bounds, blocked, allWires);
      if (other && !other.crossings) place(route, other);
    }
    wires.append(layer);
  }

  globalThis.NetBoxRackPrintLabels = {draw};
})();
