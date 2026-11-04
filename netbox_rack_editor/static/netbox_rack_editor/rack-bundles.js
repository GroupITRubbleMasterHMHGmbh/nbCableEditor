(() => {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const HALF_BADGE_HEIGHT = 9;

  function average(points, device) {
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    return {x, y, device};
  }

  function group(connections) {
    const groups = new Map();
    for (const {id, a, b} of connections) {
      const order = a.device === b.device
        ? a.x - b.x || a.y - b.y
        : a.device < b.device ? -1 : 1;
      const [first, last] = order <= 0 ? [a, b] : [b, a];
      const key = JSON.stringify([first.device, last.device]);
      if (!groups.has(key)) groups.set(key, {key, ids: [], starts: [], ends: []});
      const bundle = groups.get(key);
      bundle.ids.push(id);
      bundle.starts.push(first);
      bundle.ends.push(last);
    }
    return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map(({key, ids, starts, ends}) => ({
      key,
      ids,
      a: average(starts, starts[0].device),
      b: average(ends, ends[0].device),
    }));
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(value, high));
  }

  function anchor(point, peer, cards, direction) {
    const card = cards.get(point.device);
    const other = cards.get(peer.device);
    if (!card || !other) return point;
    const {left, right, top, bottom} = card;
    const center = {x: (left + right) / 2, y: (top + bottom) / 2};
    const xInset = Math.min(8, (right - left) / 4);
    const yInset = Math.min(8, (bottom - top) / 4);
    const x = clamp(point.x, left + xInset, right - xInset);
    const y = clamp(point.y, top + yInset, bottom - yInset);
    if (card === other) {
      const spread = Math.abs(point.x - peer.x) < 18 ? direction * 9 : 0;
      return {...point, x: clamp(x + spread, left + xInset, right - xInset), y: bottom};
    }
    if (right <= other.left || left >= other.right) {
      return {...point, x: right <= other.left ? right : left, y};
    }
    return {...point, x, y: (other.top + other.bottom) / 2 < center.y ? top : bottom};
  }

  function svg(document, tag, attributes) {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  }

  function pathData(points) {
    return points.map(({x, y}, index) => (index ? "L " : "M ") + x + " " + y).join(" ");
  }

  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function labelPoint(points, bounds, halfWidth, halfHeight, forbidden) {
    const segments = points.slice(1).map((to, i) => {
      const from = points[i];
      return {from, to, length: Math.hypot(to.x - from.x, to.y - from.y)};
    }).filter(segment => segment.length);
    const total = segments.reduce((sum, segment) => sum + segment.length, 0);
    let best;
    for (const fraction of [.5, .4, .6, .3, .7, .2, .8, .1, .9]) {
      let distance = fraction * total;
      for (const {from, to, length} of segments) {
        if (distance > length) {
          distance -= length;
          continue;
        }
        const x = clamp(from.x + (to.x - from.x) * distance / length, halfWidth + 1, bounds.width - halfWidth - 1);
        const y = clamp(from.y + (to.y - from.y) * distance / length, halfHeight + 1, bounds.height - halfHeight - 1);
        const box = {left: x - halfWidth - 2, right: x + halfWidth + 2,
          top: y - halfHeight - 2, bottom: y + halfHeight + 2};
        const collisions = forbidden.filter(area => intersects(area, box)).length;
        if (!best || collisions < best.collisions) best = {x, y, box, collisions};
        break;
      }
      if (best?.collisions === 0) break;
    }
    return best;
  }

  function draw(layer, groups, obstacles, bounds, {
    onSelect, describe, label, keyboard = false, protectedAreas = [], scale = 1, deviceClearance = 0,
  } = {}) {
    const document = layer.ownerDocument;
    const cards = new Map(obstacles.map(card => [card.id, card]));
    const connections = groups.map(bundle => ({
      id: bundle.key, a: anchor(bundle.a, bundle.b, cards, -1), b: anchor(bundle.b, bundle.a, cards, 1),
    }));
    const paths = globalThis.NetBoxRackRouting.routeCables(connections, obstacles, bounds, protectedAreas,
      {strategy: "pcb", spacing: 12, deviceClearance});
    const fragment = document.createDocumentFragment();
    const labelObstacles = [...obstacles, ...protectedAreas];
    for (const bundle of groups) {
      const points = paths.get(bundle.key);
      if (!points || points.length < 2) continue;
      const pad = Math.max(0, deviceClearance - 2);
      const cornerObstacles = obstacles.filter(card => card.id !== bundle.a.device && card.id !== bundle.b.device)
        .map(({left, right, top, bottom}) => ({left: left - pad, right: right + pad, top: top - pad, bottom: bottom + pad}));
      const smooth = globalThis.NetBoxRackCablePath?.roundPath(points, [...cornerObstacles, ...protectedAreas]);
      const d = smooth?.d ?? pathData(points);
      const groupElement = svg(document, "g", {class: "re-rack-bundle", "data-cable-bundle": bundle.key});
      if (onSelect) {
        const label = describe?.(bundle) ?? (bundle.a.device + " to " + bundle.b.device);
        groupElement.setAttribute("role", "button");
        groupElement.setAttribute("aria-label", label + ", " + bundle.ids.length +
          (bundle.ids.length === 1 ? " cable" : " cables"));
        groupElement.addEventListener("click", event => {
          event.stopPropagation();
          onSelect(bundle);
        });
        if (keyboard) {
          groupElement.setAttribute("tabindex", "0");
          groupElement.addEventListener("keydown", event => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onSelect(bundle);
          });
        }
      }
      groupElement.append(svg(document, "path", {class: "re-rack-bundle-casing", d}),
        svg(document, "path", {class: "re-rack-bundle-line", d}));
      if (onSelect) groupElement.append(svg(document, "path", {class: "re-rack-bundle-hit", d}));
      for (const end of [points[0], points.at(-1)]) {
        groupElement.append(svg(document, "circle", {class: "re-rack-bundle-anchor", cx: end.x, cy: end.y, r: 3 * scale}));
      }
      const count = String(label?.(bundle) ?? bundle.ids.length);
      const halfWidth = Math.max(10, count.length * 3.5 + 5) * scale;
      const halfHeight = HALF_BADGE_HEIGHT * scale;
      const position = labelPoint(smooth?.points ?? points, bounds, halfWidth, halfHeight, labelObstacles);
      if (position) {
        const {x, y, box} = position;
        groupElement.append(svg(document, "rect", {class: "re-rack-bundle-badge",
          x: x - halfWidth, y: y - halfHeight, width: halfWidth * 2, height: halfHeight * 2, rx: 9 * scale}));
        const text = svg(document, "text", {class: "re-rack-bundle-count",
          x, y, "text-anchor": "middle", "dominant-baseline": "central"});
        text.textContent = count;
        groupElement.append(text);
        labelObstacles.push(box);
      }
      fragment.append(groupElement);
    }
    layer.replaceChildren(fragment);
  }

  globalThis.NetBoxRackBundles = {group, draw};
})();
