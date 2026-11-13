(() => {
  "use strict";

  const kinds = [["location", "Location"], ["rack", "Rack"], ["site", "Site"]];
  const traceKinds = new Map([...kinds, ["device", "Unracked device"]]);
  const defaultBadgeWidth = 128;
  const margin = 4;
  const verticalGap = 5;

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function isRect(rect) {
    return rect && rect.right > rect.left && rect.bottom > rect.top;
  }

  function badgeFor(cable, destination) {
    if (destination) {
      const {kind, id, name} = destination;
      const label = traceKinds.get(kind);
      return label && id != null && name
        ? {key: `trace-${kind}:${id}`, kind: label, name, traceKind: kind}
        : null;
    }
    const peer = cable.externalDestinations?.[0];
    for (const [property, kind] of kinds) {
      const destination = peer?.[property];
      if (destination?.id != null && destination.name) {
        return {key: `external-${property}:${destination.id}`, kind, name: destination.name};
      }
    }
    return null;
  }

  function destinationKey(destination) {
    return JSON.stringify([
      destination.device?.id, destination.port?.id,
      destination.location?.id, destination.rack?.id, destination.site?.id,
    ]);
  }

  function routeEstimate(endpoint, targetX, obstacles, bounds, pcb, clearance) {
    const left = Math.min(endpoint.x, targetX);
    const right = Math.max(endpoint.x, targetX);
    const width = right - left;
    const blockers = obstacles.filter(card => card.id !== endpoint.device && card.left < right && card.right > left);
    const direct = y => pcb ? width + Math.abs(y - endpoint.y) : Math.hypot(width, y - endpoint.y);
    if (!blockers.length) return {lanes: [], length: direct};

    const clear = (start, end) => !blockers.some(card => intersects(start, end, card));
    const canCross = y => {
      const turn = {x: endpoint.x, y};
      return clear(endpoint, turn) && clear(turn, {x: targetX, y});
    };
    const lanes = [];
    if (canCross(endpoint.y)) {
      lanes.push(endpoint.y);
    } else {
      const edges = [...new Set(blockers.flatMap(card =>
        [card.top - clearance, card.top, card.bottom, card.bottom + clearance]
          .filter(y => y >= margin && y <= bounds.height - margin)))];
      const above = edges.filter(y => y < endpoint.y).sort((a, b) => b - a).find(canCross);
      const below = edges.filter(y => y > endpoint.y).sort((a, b) => a - b).find(canCross);
      if (above !== undefined) lanes.push(above);
      if (below !== undefined) lanes.push(below);
    }

    return {
      lanes,
      length(y) {
        if (pcb ? canCross(y) : clear(endpoint, {x: targetX, y})) return direct(y);
        // Price in the extra leg for a device crossing. The full wire router handles the final path.
        return lanes.length ? width + Math.min(...lanes.map(lane => Math.abs(lane - endpoint.y) + Math.abs(y - lane)))
          : direct(y) + bounds.width + bounds.height;
      },
    };
  }

  function slots(column, badgeHeight, bounds) {
    const result = [];
    const lastTop = bounds.height - margin - badgeHeight;
    let firstTop = margin;
    for (const {top} of [...column].sort((a, b) => a.top - b.top)) {
      const limit = top - badgeHeight - verticalGap;
      if (firstTop <= limit) result.push([firstTop, limit]);
      firstTop = Math.max(firstTop, top + badgeHeight + verticalGap);
    }
    if (firstTop <= lastTop) result.push([firstTop, lastTop]);
    return result;
  }

  function straightPathTop(routes, pcb) {
    const tops = routes.map(({y, offset}) => y - offset).sort((a, b) => a - b);
    if (pcb) return (tops[Math.floor((tops.length - 1) / 2)] + tops[Math.floor(tops.length / 2)]) / 2;
    let low = tops[0];
    let high = tops.at(-1);
    // The sum of straight-line lengths is convex, so its slope identifies the best starting point.
    for (let step = 0; step < 14 && high - low > .1; step++) {
      const top = (low + high) / 2;
      const slope = routes.reduce((sum, {xDistance, y, offset}) => {
        const vertical = top + offset - y;
        return sum + (vertical / Math.hypot(xDistance, vertical) || 0);
      }, 0);
      if (slope > 0) high = top;
      else low = top;
    }
    return (low + high) / 2;
  }

  function bestPlacement(group, side, obstacles, bounds, badgeHeight, pcb, clearance) {
    const routes = group.entries.map(({endpoint}, lane) => ({
      ...routeEstimate(endpoint, side.targetX, obstacles, bounds, pcb, clearance),
      offset: badgeHeight * (lane + 1) / (group.entries.length + 1),
      xDistance: Math.abs(endpoint.x - side.targetX),
      y: endpoint.y,
    }));
    const preferred = routes.flatMap(({y, offset, lanes}) => [y - offset, ...lanes.map(lane => lane - offset)])
      .sort((a, b) => a - b);
    const suggestions = [straightPathTop(routes, pcb), group.center - badgeHeight / 2,
      ...[0, .25, .5, .75, 1].map(fraction => preferred[Math.round((preferred.length - 1) * fraction)])];
    const open = slots(side.groups, badgeHeight, bounds);
    const crowded = !open.length;
    if (crowded) open.push([margin, Math.max(margin, bounds.height - margin - badgeHeight)]);

    let best = null;
    for (const [first, last] of open) {
      for (const top of new Set(suggestions.map(y => clamp(y, first, last)))) {
        const distance = routes.reduce((sum, route) => sum + route.length(top + route.offset), 0);
        if (!best || distance < best.distance) best = {top, distance, crowded};
      }
    }
    return best;
  }

  function layout(candidates, {bounds, faces, obstacles = []},
    {badgeWidth = defaultBadgeWidth, badgeHeight = 18, gap = 10, strategy, deviceClearance = 0} = {}) {
    const targets = new Map();
    if (!candidates.length) return {groups: [], targets};
    const rack = [...Object.values(faces ?? {}), ...obstacles].filter(isRect);
    const height = bounds.height - 2 * margin;
    if (!rack.length || height <= 0) return {groups: [], targets};

    const edges = rack.reduce((result, rect) => ({
      left: Math.min(result.left, rect.left), right: Math.max(result.right, rect.right),
    }), {left: Infinity, right: -Infinity});
    const sides = [
      {side: "left", targetX: edges.left - gap, available: edges.left - gap - margin, groups: []},
      {side: "right", targetX: edges.right + gap, available: bounds.width - edges.right - gap - margin, groups: []},
    ].filter(side => side.available >= 24);
    if (!sides.length) return {groups: [], targets};

    const byBadge = new Map();
    for (const {id, cable, endpoint, destination, destinations} of candidates) {
      const badge = endpoint && badgeFor(cable, destination);
      if (!badge) continue;
      if (!byBadge.has(badge.key)) {
        byBadge.set(badge.key, {...badge, entries: [], peers: new Map()});
      }
      const group = byBadge.get(badge.key);
      group.entries.push({id: id ?? cable.id, cable, endpoint});
      const peers = destination ? destinations : cable.externalDestinations;
      for (const peer of peers ?? []) group.peers.set(destinationKey(peer), peer);
    }

    const sorted = [...byBadge.values()].map(group => {
      const entries = group.entries.sort((a, b) => a.endpoint.y - b.endpoint.y || a.endpoint.x - b.endpoint.x ||
        String(a.id).localeCompare(String(b.id), "en", {numeric: true}));
      const center = (entries[Math.floor((entries.length - 1) / 2)].endpoint.y +
        entries[Math.floor(entries.length / 2)].endpoint.y) / 2;
      return {...group, center};
    }).sort((a, b) => a.center - b.center || a.key.localeCompare(b.key, "en", {numeric: true}));

    for (const group of sorted) {
      const placements = sides.map(side => ({side, ...bestPlacement(group, side, obstacles, bounds, badgeHeight,
        strategy === "pcb", deviceClearance)}));
      placements.sort((a, b) => Number(a.crowded) - Number(b.crowded) ||
        (a.crowded && b.crowded ? a.side.groups.length - b.side.groups.length : 0) || a.distance - b.distance);
      const {side, top} = placements[0];
      side.groups.push({...group, top});
    }

    const groups = [];
    for (const {side, targetX, available, groups: column} of sides) {
      if (!column.length) continue;
      column.sort((a, b) => a.top - b.top || a.center - b.center);
      const scale = Math.min(1, height / (column.length * badgeHeight + (column.length - 1) * verticalGap));
      const width = Math.min(badgeWidth, available);
      const step = (badgeHeight + verticalGap) * scale;
      const rowHeight = badgeHeight * scale;
      const left = side === "left" ? targetX - width : targetX;
      const rows = [];
      for (const group of column) {
        rows.push(Math.max(margin, group.top + (badgeHeight - rowHeight) / 2, rows.length ? rows.at(-1) + step : 0));
      }
      for (let index = rows.length - 1; index >= 0; index--) {
        const limit = index === rows.length - 1 ? bounds.height - margin - rowHeight : rows[index + 1] - step;
        rows[index] = Math.min(rows[index], limit);
      }
      for (const [index, group] of column.entries()) {
        const top = rows[index];
        const rect = {left, top, right: left + width, bottom: top + rowHeight};
        const cableCount = group.entries.length;
        for (const [lane, {id}] of group.entries.entries()) {
          // Use separate landing points on the same badge so converging wires remain individually selectable.
          const y = top + rowHeight * (lane + 1) / (cableCount + 1);
          targets.set(id, {x: targetX, y, device: group.key, port: `external-target:${id}`});
        }
        const {key, kind, name, traceKind, peers} = group;
        groups.push({
          key, kind, name, traceKind, side, rect, destinations: [...peers.values()],
          cables: group.entries.map(({cable}) => cable),
          routeIds: group.entries.map(({id}) => id),
        });
      }
    }
    return {groups, targets};
  }

  function intersects(a, b, rect) {
    let enter = 0;
    let exit = 1;
    for (const [start, end, low, high] of [
      [a.x, b.x, rect.left, rect.right], [a.y, b.y, rect.top, rect.bottom],
    ]) {
      if (start === end) {
        if (start <= low || start >= high) return false;
        continue;
      }
      const first = (low - start) / (end - start);
      const last = (high - start) / (end - start);
      enter = Math.max(enter, Math.min(first, last));
      exit = Math.min(exit, Math.max(first, last));
    }
    return enter < exit;
  }

  function contains(rect, {x, y}, margin) {
    return x > rect.left - margin && x < rect.right + margin &&
      y > rect.top - margin && y < rect.bottom + margin;
  }

  function hits(points, rect) {
    return points.slice(1).some((point, index) => intersects(points[index], point, rect));
  }

  function stub(endpoint, sourceRect, {bounds, obstacles = [], protectedAreas = []}, {radius = 4} = {}) {
    if (!endpoint) return null;
    const start = {x: endpoint.x, y: endpoint.y};
    const source = sourceRect ?? {left: start.x, right: start.x, top: start.y, bottom: start.y};
    const margin = radius + 1;
    if (bounds.width < 2 * margin || bounds.height < 2 * margin) return null;
    const inTravelBand = rect => isRect(rect) && rect.bottom >= Math.min(start.y, source.top) - margin - 15 &&
      rect.top <= Math.max(start.y, source.bottom) + margin + 15;
    const cards = obstacles.filter(rect => rect !== sourceRect &&
      (endpoint.device == null || rect.id !== endpoint.device) && inTravelBand(rect));
    const ownMarker = endpoint.port == null ? null : protectedAreas.find(rect => rect.port === endpoint.port);
    const markers = protectedAreas.filter(rect => rect !== ownMarker && inTravelBand(rect));
    const near = start.y - source.top <= source.bottom - start.y ? -1 : 1;
    const preferredSide = start.x < (source.left + source.right) / 2 ? -1 : 1;
    const xPositions = [...new Set([
      start.x, start.x + 10 * preferredSide, start.x - 10 * preferredSide,
      start.x + 22 * preferredSide, start.x - 22 * preferredSide,
      source.left - margin - 3, source.right + margin + 3, margin, bounds.width - margin,
    ].map(x => clamp(x, margin, bounds.width - margin)))];
    let best = null;
    let bestScore = Infinity;

    for (const direction of [near, -near]) {
      const edge = direction < 0 ? source.top : source.bottom;
      const lead = direction < 0 ? (ownMarker?.top ?? start.y - 3) - 1 : (ownMarker?.bottom ?? start.y + 3) + 1;
      for (const distance of [margin + 7, margin, margin + 15]) {
        const y = clamp(edge + distance * direction, margin, bounds.height - margin);
        if ((y - edge) * direction < margin) continue;
        for (const x of xPositions) {
          const end = {x, y};
          if (cards.some(rect => contains(rect, end, margin)) || markers.some(rect => contains(rect, end, margin))) {
            continue;
          }
          const paths = [[start, end]];
          if (x !== start.x) {
            paths.push([start, {x: start.x, y: clamp(lead, 0, bounds.height)}, {x, y: clamp(lead, 0, bounds.height)}, end]);
          }
          for (const points of paths) {
            const deviceHits = cards.filter(rect => hits(points, rect)).length;
            const markerHits = markers.filter(rect => hits(points, rect)).length;
            const length = points.slice(1).reduce((sum, point, index) =>
              sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
            const score = length + deviceHits * 1000 + markerHits * 150 + (direction === near ? 0 : 12) +
              Math.abs(distance - margin - 7) * 2;
            if (score < bestScore) {
              best = points;
              bestScore = score;
            }
            if (!deviceHits && !markerHits && direction === near && distance === margin + 7 && x === start.x) {
              return points;
            }
          }
        }
      }
    }
    return best;
  }

  globalThis.NbCableEditorExternalLocations = {layout, stub, badgeWidth: defaultBadgeWidth};
})();
