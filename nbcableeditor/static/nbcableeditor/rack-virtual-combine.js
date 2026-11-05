(() => {
  "use strict";

  function findRuns(connections, portRows) {
    const positions = new Map();
    for (const row of portRows) {
      row.ports.forEach((port, index) => positions.set(port, {row: row.id, device: row.deviceId, index}));
    }
    const usage = new Map();
    for (const {a, b} of connections) {
      for (const {port} of [a, b]) usage.set(port, (usage.get(port) ?? 0) + 1);
    }

    const pairs = new Map();
    for (const {id, a, b} of connections) {
      const from = positions.get(a.port);
      const to = positions.get(b.port);
      if (!from || !to || usage.get(a.port) !== 1 || usage.get(b.port) !== 1) continue;
      if (from.row === to.row || (from.device !== undefined && from.device === to.device)) continue;
      const [first, second] = from.row < to.row ? [from, to] : [to, from];
      const key = JSON.stringify([first.row, second.row]);
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push({id, first: first.index, second: second.index});
    }

    const runs = [];
    for (const pair of pairs.values()) {
      pair.sort((a, b) => a.first - b.first || a.second - b.second);
      let ids = [];
      let previous;
      for (const connection of pair) {
        if (previous && (connection.first !== previous.first + 1 || connection.second !== previous.second + 1)) {
          if (ids.length > 1) runs.push({ids});
          ids = [];
        }
        ids.push(connection.id);
        previous = connection;
      }
      if (ids.length > 1) runs.push({ids});
    }
    return runs;
  }

  const LANE_PITCH = 1.1;
  const BRANCH_PITCH = 8.5;
  const BRANCH_CLEARANCE = 25;
  const TUBE_PADDING = 2.5;
  const MIN_TUBE_LENGTH = 18;
  const FOREIGN_CABLE_CLEARANCE = 15;
  const PARALLEL_CABLE_CLEARANCE = 25;
  const TUBE_BORDER_RADIUS = .75;
  const CURVE_SAMPLE_ALLOWANCE = .25;
  const MAX_EXTRA_TRAVEL = 96;
  const DENSE_RUN_SIZE = 12;
  const USEFUL_SLEEVE_LENGTH = 60;

  function runsAlongTube(a, b, axis = "vertical") {
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    return axis === "horizontal" ? dx >= 4 && dx >= 3 * dy : dy >= 4 && dy >= 3 * dx;
  }

  function lineSegments(routes, excluded) {
    const segments = [];
    for (const [id, points] of routes) {
      if (excluded.has(id)) continue;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        if (a.x === b.x && a.y === b.y) continue;
        segments.push({a, b,
          left: Math.min(a.x, b.x), right: Math.max(a.x, b.x),
          top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y)});
      }
    }
    return segments;
  }

  function sectionWithinColumns(segment, left, right) {
    if (segment.right < left || segment.left > right) return null;
    const {a, b} = segment;
    const dx = b.x - a.x;
    if (dx === 0) return [segment.top, segment.bottom];
    const t1 = (left - a.x) / dx;
    const t2 = (right - a.x) / dx;
    const start = Math.max(0, Math.min(t1, t2));
    const end = Math.min(1, Math.max(t1, t2));
    const y1 = a.y + (b.y - a.y) * start;
    const y2 = a.y + (b.y - a.y) * end;
    return [Math.min(y1, y2), Math.max(y1, y2)];
  }

  function blockedTubeSections(x, width, foreign, obstacles, spacing, axis = "vertical") {
    const {tubeGap, parallelGap, foreignClearance, parallelClearance} = spacing;
    const blocks = [];
    for (const obstacle of obstacles) {
      const isTube = obstacle.cableClearance !== undefined;
      const end = isTube ? tubeGap + 2 * TUBE_BORDER_RADIUS : 2;
      const sameDirection = isTube && (obstacle.axis ?? "vertical") === axis;
      const side = sameDirection ? Math.max(obstacle.parallelGap, parallelGap) + 2 * TUBE_BORDER_RADIUS : isTube ? end : 1;
      if (obstacle.left > x + width / 2 + side || obstacle.right < x - width / 2 - side) continue;
      blocks.push([obstacle.top - end, obstacle.bottom + end]);
    }
    for (const segment of foreign) {
      const side = runsAlongTube(segment.a, segment.b) ? parallelClearance : foreignClearance;
      const blocked = sectionWithinColumns(segment, x - width / 2 - side, x + width / 2 + side);
      if (blocked) blocks.push([blocked[0] - foreignClearance, blocked[1] + foreignClearance]);
    }
    blocks.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const block of blocks) {
      const previous = merged.at(-1);
      if (previous && block[0] <= previous[1]) previous[1] = Math.max(previous[1], block[1]);
      else merged.push(block);
    }
    return merged;
  }

  function clearTubeSection(from, to, blocks) {
    let top = from;
    let best;
    function consider(bottom) {
      if (bottom - top >= MIN_TUBE_LENGTH && (!best || bottom - top > best.bottom - best.top)) {
        best = {top, bottom};
      }
    }
    for (const [start, end] of blocks) {
      if (end <= top) continue;
      if (start >= to) break;
      consider(start);
      top = Math.max(top, end);
      if (top >= to) break;
    }
    consider(to);
    return best;
  }

  function preferredExit(ports, card, facing) {
    const middle = (card.top + card.bottom) / 2;
    const row = ports.reduce((sum, port) => sum + port.y, 0) / ports.length;
    return Math.abs(row - middle) < 1 ? facing : row < middle ? -1 : 1;
  }

  function fanRanks(ports, laneXs) {
    const byDistance = ports.map((port, index) => ({index, offset: port.x - laneXs[index]}))
      .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
    const counts = new Map();
    const ranks = [];
    for (const {index, offset} of byDistance) {
      const side = Math.sign(offset);
      const rank = counts.get(side) ?? 0;
      counts.set(side, rank + 1);
      ranks[index] = rank;
    }
    return ranks;
  }

  function hits(a, b, rect, clearance, sideClearance = clearance) {
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y, b.y);
    if (left >= rect.right + sideClearance || right <= rect.left - sideClearance ||
        top >= rect.bottom + clearance || bottom <= rect.top - clearance) return false;
    if (left === right || top === bottom) return true;
    const section = sectionWithinColumns({a, b, left, right, top, bottom},
      rect.left - sideClearance, rect.right + sideClearance);
    return section[0] < rect.bottom + clearance && section[1] > rect.top - clearance;
  }

  function pathIsClear(points, start, end, obstacles, protectedAreas, bounds, clearance, deviceClearance, fan = false) {
    if (points.some(({x, y}) => x < 0 || y < 0 || x > bounds.width || y > bounds.height)) return false;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      for (const obstacle of obstacles) {
        if ((i === 1 && obstacle.id === start.device) ||
            (!fan && i === points.length - 1 && obstacle.id === end.device)) continue;
        const own = !obstacle.id || obstacle.id === start.device || obstacle.id === end.device;
        if (obstacle.cableClearance !== undefined) {
          if (hitsTube(a, b, obstacle)) return false;
        } else if (hits(a, b, obstacle, own ? clearance : deviceClearance)) return false;
      }
      for (const area of protectedAreas) {
        if (area.port !== start.port && area.port !== end.port && hits(a, b, area, .25)) return false;
      }
    }
    return true;
  }

  function fanPoints(port, lane, {rails, shoulder}, index) {
    const rail = rails[index];
    return [port, {x: port.x, y: shoulder ?? rail}, {x: lane, y: rail}];
  }

  function fanLayouts(ports, peers, lanes, edge, direction, outward,
    obstacles, protectedAreas, bounds, clearance, deviceClearance) {
    const ranks = fanRanks(ports, lanes);
    const lastRank = Math.max(...ranks);
    const layouts = [];
    const minGap = clearance + 1;
    const desiredGap = Math.max(BRANCH_CLEARANCE, deviceClearance, minGap);
    // Keep the full spacing when the bay fits it. Narrow bays relax pitch and clearance
    // independently at each device, with the original close fan as the last fallback.
    const fallbackGaps = [desiredGap, BRANCH_CLEARANCE, 17, 10, minGap];
    const outsideRoom = direction < 0 ? edge : bounds.height - edge;
    function add(layout) {
      if (ports.every((port, i) => pathIsClear(fanPoints(port, lanes[i], layout, i), port, peers[i],
        obstacles, protectedAreas, bounds, clearance, deviceClearance, true))) layouts.push(layout);
    }
    if (ports.length >= DENSE_RUN_SIZE && !outward) {
      // A monotone taper brings a whole row into the sleeve in a fixed depth.
      // The first segment stays perpendicular to the panel, clear of the next port.
      for (const gap of new Set(fallbackGaps.map(gap => Math.max(gap, minGap)))) {
        for (const depth of [12, 7]) {
          add({
            shoulder: edge + direction * gap,
            rails: ports.map(() => edge + direction * (gap + depth)),
            loss: 2 * Math.max(0, desiredGap - gap) + 12 - depth,
          });
        }
      }
      if (layouts.length) return layouts.sort((a, b) => a.loss - b.loss);
    }
    const pitches = lastRank ? [BRANCH_PITCH, 6, 3.5] : [BRANCH_PITCH];
    if (ports.length >= DENSE_RUN_SIZE && outward && lastRank) {
      const availablePitch = (outsideRoom - Math.max(minGap, 10)) / lastRank;
      if (availablePitch < 3.5) {
        // Outward returns still need staggered rails to avoid crossing their own fans.
        const compactPitch = Math.max(1.35, Math.min(3.5, availablePitch));
        pitches.push(compactPitch, 1.35);
      }
    }
    for (const pitch of pitches) {
      const gaps = new Set(fallbackGaps.map(gap => Math.max(gap, minGap)));
      if (outward) {
        const limit = outsideRoom - lastRank * pitch - 5;
        for (const gap of [desiredGap + 16, desiredGap + 32, desiredGap + 48, desiredGap + 64, limit]) {
          if (gap > desiredGap && gap <= limit) gaps.add(gap);
        }
      }
      for (const gap of gaps) {
        const rails = ranks.map(rank => edge + direction * (gap + rank * pitch));
        add({rails, loss: 2 * (Math.max(0, desiredGap - gap) + lastRank * (BRANCH_PITCH - pitch))});
      }
    }
    return layouts.sort((a, b) => a.loss - b.loss);
  }

  function hitsTube(a, b, tube) {
    const side = runsAlongTube(a, b, tube.axis) ? tube.parallelClearance : tube.cableClearance;
    return tube.axis === "horizontal" ? hits(a, b, tube, side, tube.cableClearance)
      : hits(a, b, tube, tube.cableClearance, side);
  }

  function clearsPriorTubes(points, priorTubes) {
    for (let i = 1; i < points.length; i++) {
      if (priorTubes.some(tube => hitsTube(points[i - 1], points[i], tube))) return false;
    }
    return true;
  }

  function chooseTube(ids, connections, cards, foreign, obstacles, protectedAreas, bounds,
    clearance, deviceClearance, deviceEdgeClearance, spacing, compactPoints) {
    const {parallelClearance} = spacing;
    const first = connections.get(ids[0]);
    const firstCard = cards.get(first.a.device);
    const lastCard = cards.get(first.b.device);
    if (!firstCard || !lastCard) return null;
    const [upper, lower] = firstCard.top < lastCard.top ? [firstCard, lastCard] : [lastCard, firstCard];
    if (upper.bottom > lower.top) return null;
    const cables = ids.map(id => connections.get(id));
    const ends = cables.map(cable => cable.a.device === upper.id ? [cable.a, cable.b] : [cable.b, cable.a]);
    const upperPorts = ends.map(([port]) => port);
    const lowerPorts = ends.map(([, port]) => port);
    const upperExit = preferredExit(upperPorts, upper, 1);
    const lowerExit = preferredExit(lowerPorts, lower, -1);
    const coverageWeight = ids.length >= DENSE_RUN_SIZE ? 1.5 : 0;
    const pitch = Math.min(LANE_PITCH, 8 / (ids.length - 1));
    const width = (ids.length - 1) * pitch + 2 * TUBE_PADDING;
    const relevant = [...cards.values()].filter(card => card.bottom >= upper.top && card.top <= lower.bottom);
    const sideMargin = Math.max(deviceClearance + width / 2 - TUBE_PADDING,
      deviceEdgeClearance + width / 2 + TUBE_BORDER_RADIUS);
    const left = Math.min(...relevant.map(card => card.left)) - sideMargin;
    const right = Math.max(...relevant.map(card => card.right)) + sideMargin;
    const middle = ends.reduce((sum, [a, b]) => sum + a.x + b.x, 0) / (2 * ends.length);
    const columns = new Set([middle, middle - 12, middle + 12, middle - 28, middle + 28]);
    for (const offset of [.25, 1, 1.75, 2, 10, 20, 32, 48, 68, 88]) {
      columns.add(left - offset);
      columns.add(right + offset);
    }
    const boardLeft = width / 2 + 1;
    const boardRight = bounds.width - boardLeft;
    for (const [start, end] of [[boardLeft, left], [right, boardRight]]) {
      if (start > end) continue;
      columns.add(start);
      columns.add(end);
      columns.add((start + end) / 2);
    }
    const trackMargin = parallelClearance + width / 2 + .25;
    const neighboringTracks = foreign.filter(segment => runsAlongTube(segment.a, segment.b) &&
      segment.top < lower.bottom && segment.bottom > upper.top);
    const neighboringColumns = new Set(neighboringTracks.flatMap(segment => [
      segment.left - trackMargin, segment.right + trackMargin,
    ]).filter(x => x >= boardLeft && x <= boardRight));
    for (const [reference, eligible] of [[left, x => x <= left], [right, x => x >= right],
      [middle, x => x > left && x < right && Math.abs(x - middle) <= 64]]) {
      const nearest = [...neighboringColumns].filter(eligible)
        .sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference)).slice(0, 8);
      for (const x of nearest) columns.add(x);
    }
    let bestExits = Infinity;
    let bestScore = Infinity;
    let shortest = Infinity;
    let finalists = [];
    const tubeObstacles = [...obstacles, ...protectedAreas];
    const priorTubes = obstacles.filter(obstacle => obstacle.cableClearance !== undefined);
    for (const x of columns) {
      if (x < boardLeft || x > boardRight) continue;
      let blocks;
      const laneXs = ids.map((_, i) => x + (i - (ids.length - 1) / 2) * pitch);
      for (const directionA of [upperExit, -upperExit]) {
        for (const directionB of [lowerExit, -lowerExit]) {
          const exits = Number(directionA !== upperExit) + Number(directionB !== lowerExit);
          if (exits > bestExits) continue;
          // An outward exit bends back alongside its fan. Reverse its tracks so the visible
          // branches stay separate, then change track order inside the covered section.
          const lanesA = directionA < 0 ? laneXs.slice().reverse() : laneXs;
          const lanesB = directionB > 0 ? laneXs.slice().reverse() : laneXs;
          const layoutsA = fanLayouts(upperPorts, lowerPorts, lanesA, directionA < 0 ? upper.top : upper.bottom,
            directionA, directionA < 0, obstacles, protectedAreas, bounds, clearance, deviceClearance);
          const layoutsB = fanLayouts(lowerPorts, upperPorts, lanesB, directionB < 0 ? lower.top : lower.bottom,
            directionB, directionB > 0, obstacles, protectedAreas, bounds, clearance, deviceClearance);
          for (const first of layoutsA) for (const last of layoutsB) {
            const loss = first.loss + last.loss;
            if (exits === bestExits && loss - USEFUL_SLEEVE_LENGTH * coverageWeight > bestScore) break;
            const railA = first.rails;
            const railB = last.rails;
            const top = Math.max(...railA) + 2;
            const bottom = Math.min(...railB) - 2;
            if (bottom - top < MIN_TUBE_LENGTH) continue;
            blocks ??= blockedTubeSections(x, width, foreign, tubeObstacles, spacing);
            const section = clearTubeSection(top, bottom, blocks);
            if (!section) continue;
            const span = section.bottom - section.top;
            const score = loss - Math.min(span, USEFUL_SLEEVE_LENGTH) * coverageWeight;
            if (exits === bestExits && score > bestScore) continue;

            const paths = new Map();
            let length = 0;
            for (const [index, [start, end]] of ends.entries()) {
              const firstLane = lanesA[index];
              const lastLane = lanesB[index];
              const points = fanPoints(start, firstLane, first, index);
              if (firstLane !== lastLane) {
                points.push({x: firstLane, y: section.top + 3}, {x: lastLane, y: section.bottom - 3});
              }
              points.push(...fanPoints(end, lastLane, last, index).reverse());
              if (!pathIsClear(points, start, end, obstacles, protectedAreas, bounds, clearance, deviceClearance)) break;
              for (let i = 1; i < points.length; i++) {
                length += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
              }
              const distinct = points.filter((point, i) => !i || point.x !== points[i - 1].x || point.y !== points[i - 1].y);
              paths.set(ids[index], cables[index].a === start ? distinct : distinct.reverse());
            }
            if (paths.size !== ids.length) continue;
            const travel = length / paths.size;
            const betterFit = exits < bestExits || score < bestScore;
            if (!betterFit && (travel > shortest + MAX_EXTRA_TRAVEL ||
                finalists.some(plan => plan.travel <= travel && plan.span >= span))) continue;
            const projected = new Map([...paths].map(([id, points]) => [id, compactPoints(id, points)]));
            if (priorTubes.length && [...projected.values()].some(points => !clearsPriorTubes(points, priorTubes))) continue;
            if (betterFit) {
              bestExits = exits;
              bestScore = score;
              shortest = Infinity;
              finalists = [];
            }
            shortest = Math.min(shortest, travel);
            finalists = finalists.filter(plan => plan.travel <= shortest + MAX_EXTRA_TRAVEL &&
              (plan.travel < travel || plan.span > span));
            finalists.push({paths, projected, tube: {ids, x, width, ...section}, travel, span, loss});
          }
        }
      }
      // With both rows facing the gap, a centered taper that already covers a useful
      // part of the gap does not need to compete with routes around the rack sides.
      if (coverageWeight && x === middle && upperExit > 0 && lowerExit < 0 &&
          bestExits === 0 && finalists.some(plan => plan.span >= Math.max(
            MIN_TUBE_LENGTH, Math.min(USEFUL_SLEEVE_LENGTH, (lower.top - upper.bottom) / 4),
          ))) break;
    }
    const best = finalists.sort((a, b) => b.span - a.span || a.travel - b.travel)[0];
    return best ? {...best, exits: bestExits} : null;
  }

  function transposeBox({left, right, top, bottom, ...properties}) {
    return {...properties, left: top, right: bottom, top: left, bottom: right};
  }

  function horizontalRows(left, right, width, cards, foreign, bounds, sideMargin, parallelClearance) {
    const minimum = width / 2 + 1;
    const maximum = bounds.height - minimum;
    const rows = new Set([minimum, maximum, (left.y + right.y) / 2]);
    for (const card of cards) {
      for (const offset of [0, 10, 20, 32]) {
        rows.add(card.top - sideMargin - offset);
        rows.add(card.bottom + sideMargin + offset);
      }
    }
    const margin = parallelClearance + width / 2 + .25;
    const neighbors = foreign.filter(segment => segment.top <= right.x && segment.bottom >= left.x &&
      runsAlongTube(segment.a, segment.b));
    const boundaries = new Set(neighbors.flatMap(segment => [segment.left - margin, segment.right + margin]));
    for (const edge of [left.y, right.y]) {
      const nearest = [...boundaries].filter(y => y >= minimum && y <= maximum)
        .sort((a, b) => Math.abs(a - edge) - Math.abs(b - edge)).slice(0, 8);
      for (const y of nearest) rows.add(y);
    }
    return [...rows].filter(y => y >= minimum && y <= maximum);
  }

  function chooseHorizontalTube(ids, connections, cards, foreign, obstacles, protectedAreas, bounds,
    clearance, deviceClearance, deviceEdgeClearance, spacing, compactPoints) {
    const {parallelClearance} = spacing;
    const cables = ids.map(id => connections.get(id));
    const ends = cables.map(({a, b}) => a.x < b.x ? [a, b] : [b, a]);
    const starts = ends.map(([port]) => port);
    const endsOnRight = ends.map(([, port]) => port);
    const left = Math.max(...starts.map(port => port.x)) + 4;
    const right = Math.min(...endsOnRight.map(port => port.x)) - 4;
    if (right - left < MIN_TUBE_LENGTH) return null;

    const leftCard = cards.get(starts[0].device);
    const rightCard = cards.get(endsOnRight[0].device);
    if (!leftCard || !rightCard || starts.some(port => port.device !== leftCard.id) ||
        endsOnRight.some(port => port.device !== rightCard.id)) return null;
    const startExit = preferredExit(starts, leftCard, leftCard.top <= rightCard.top ? 1 : -1);
    const endExit = preferredExit(endsOnRight, rightCard, rightCard.top <= leftCard.top ? 1 : -1);
    const pitch = Math.min(LANE_PITCH, 8 / (ids.length - 1));
    const width = (ids.length - 1) * pitch + 2 * TUBE_PADDING;
    const halfLanes = width / 2 - TUBE_PADDING;
    const minimumX = Math.min(...starts.map(port => port.x));
    const maximumX = Math.max(...endsOnRight.map(port => port.x));
    const relevant = [...cards.values()].filter(card => card.left <= maximumX && card.right >= minimumX);
    const sideMargin = Math.max(deviceClearance + halfLanes, deviceEdgeClearance + width / 2 + TUBE_BORDER_RADIUS);
    const transposedForeign = foreign.map(({a, b, ...segment}) => ({...transposeBox(segment),
      a: {x: a.y, y: a.x}, b: {x: b.y, y: b.x}}));
    const tubeObstacles = [...obstacles, ...protectedAreas].map(transposeBox);
    const rows = horizontalRows({x: left, y: starts[0].y}, {x: right, y: endsOnRight[0].y},
      width, relevant, transposedForeign, bounds, sideMargin, parallelClearance);
    const priorTubes = obstacles.filter(obstacle => obstacle.cableClearance !== undefined);
    let bestExits = Infinity;
    let bestLoss = Infinity;
    let finalists = [];
    for (const y of rows) {
      const startDirection = y < leftCard.top ? -1 : y > leftCard.bottom ? 1 : 0;
      const endDirection = y < rightCard.top ? -1 : y > rightCard.bottom ? 1 : 0;
      if (!startDirection || !endDirection) continue;
      const startDistance = Math.abs(y - (startDirection < 0 ? leftCard.top : leftCard.bottom)) - halfLanes;
      const endDistance = Math.abs(y - (endDirection < 0 ? rightCard.top : rightCard.bottom)) - halfLanes;
      if (Math.min(startDistance, endDistance) < clearance) continue;
      const exits = Number(startDirection !== startExit) + Number(endDirection !== endExit);
      const edgeGap = deviceEdgeClearance + TUBE_PADDING + TUBE_BORDER_RADIUS;
      const loss = 2 * (Math.max(0, edgeGap - startDistance) + Math.max(0, edgeGap - endDistance));
      if (exits > bestExits || (exits === bestExits && loss > bestLoss)) continue;
      const section = clearTubeSection(left, right,
        blockedTubeSections(y, width, transposedForeign, tubeObstacles, spacing, "horizontal"));
      if (!section) continue;
      const span = section.bottom - section.top;
      const lanes = ids.map((_, i) => y + (i - (ids.length - 1) / 2) * pitch);
      const startLanes = startDirection > 0 ? lanes.slice().reverse() : lanes;
      const endLanes = endDirection < 0 ? lanes.slice().reverse() : lanes;
      const paths = new Map();
      let length = 0;
      for (const [i, [start, end]] of ends.entries()) {
        const firstLane = startLanes[i];
        const lastLane = endLanes[i];
        const points = [start, {x: start.x, y: firstLane}];
        // When the fan orders differ, the only crossing is inside the covered section.
        if (firstLane !== lastLane) {
          points.push({x: section.top + 3, y: firstLane}, {x: section.bottom - 3, y: lastLane});
        }
        points.push({x: end.x, y: lastLane}, end);
        if (!pathIsClear(points, start, end, obstacles, protectedAreas, bounds, clearance, deviceClearance)) break;
        length += end.x - start.x + Math.abs(start.y - firstLane) + Math.abs(end.y - lastLane) +
          Math.abs(firstLane - lastLane);
        paths.set(ids[i], cables[i].a === start ? points : points.reverse());
      }
      if (paths.size !== ids.length) continue;
      const travel = length / paths.size;
      const projected = new Map([...paths].map(([id, points]) => [id, compactPoints(id, points)]));
      if (priorTubes.length && [...projected.values()].some(points => !clearsPriorTubes(points, priorTubes))) continue;
      if (exits < bestExits || loss < bestLoss) {
        bestExits = exits;
        bestLoss = loss;
        finalists = [];
      }
      finalists.push({paths, projected, tube: {ids, axis: "horizontal", y, width, left: section.top, right: section.bottom},
        travel, span, exits, loss});
    }
    const shortest = Math.min(...finalists.map(plan => plan.travel));
    return finalists.filter(plan => plan.travel <= shortest + MAX_EXTRA_TRAVEL)
      .sort((a, b) => b.span - a.span || a.travel - b.travel)[0];
  }

  function preferredTube(vertical, horizontal) {
    if (!vertical) return horizontal;
    if (!horizontal || horizontal.exits > vertical.exits || horizontal.loss > vertical.loss ||
        horizontal.travel > vertical.travel + MAX_EXTRA_TRAVEL) return vertical;
    const moreCoverage = horizontal.span >= vertical.span + Math.max(12, vertical.span * .15);
    const shorterTravel = horizontal.span >= vertical.span && horizontal.travel + 24 < vertical.travel;
    return moreCoverage || shorterTravel ? horizontal : vertical;
  }

  function tubeBounds(tube) {
    const radius = tube.width / 2;
    return tube.axis === "horizontal" ? {axis: tube.axis, left: tube.left, right: tube.right,
      top: tube.y - radius, bottom: tube.y + radius} :
      {left: tube.x - radius, right: tube.x + radius, top: tube.top, bottom: tube.bottom};
  }

  function planTubes(connections, portRows, routes, {obstacles = [], protectedAreas = [], bounds,
    clearance = 3, deviceClearance = clearance, deviceEdgeClearance = Math.min(deviceClearance, BRANCH_CLEARANCE),
    foreignStrokeWidth = 0, foreignRoutes = routes,
    tubeGap = FOREIGN_CABLE_CLEARANCE, tubeParallelGap = PARALLEL_CABLE_CLEARANCE,
    compactPoints = (_id, points) => points} = {}) {
    const paths = new Map();
    const tubes = [];
    const byId = new Map(connections.map(cable => [cable.id, cable]));
    const cards = new Map(obstacles.map(card => [card.id, card]));
    const occupied = [...obstacles];
    const displayed = new Map(foreignRoutes);
    const foreignClearance = tubeGap + TUBE_BORDER_RADIUS + CURVE_SAMPLE_ALLOWANCE +
      Math.max(0, foreignStrokeWidth) / 2;
    const preferredGap = Math.max(tubeGap, tubeParallelGap);
    const parallelGaps = new Set([preferredGap, (preferredGap + tubeGap) / 2, tubeGap]);
    for (const {ids} of findRuns(connections, portRows)) {
      if (ids.length < 3 || !ids.every(id => routes.has(id))) continue;
      const foreign = lineSegments(displayed, new Set(ids));
      const {a, b} = byId.get(ids[0]);
      let plan;
      for (const parallelGap of parallelGaps) {
        const parallelClearance = foreignClearance + parallelGap - tubeGap;
        const spacing = {tubeGap, parallelGap, foreignClearance, parallelClearance};
        const options = [ids, byId, cards, foreign, occupied, protectedAreas, bounds, clearance,
          Math.max(clearance, deviceClearance), deviceEdgeClearance, spacing, compactPoints];
        const candidate = preferredTube(chooseTube(...options), chooseHorizontalTube(...options));
        if (!candidate) continue;
        // Keep the wider separation unless a tighter corridor provides substantially more sleeve.
        if (!plan || candidate.span >= plan.span + Math.max(24, plan.span * .25)) {
          plan = {...candidate, parallelGap, parallelClearance};
        }
        const separation = plan.tube.axis === "horizontal" ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y);
        if (plan.span >= Math.max(48, separation * .45)) break;
      }
      if (!plan) continue;
      for (const [id, points] of plan.paths) {
        paths.set(id, points);
        displayed.set(id, plan.projected.get(id));
      }
      const {tube} = plan;
      tubes.push({...tube, parallelGap: plan.parallelGap});
      occupied.push({...tubeBounds(tube), cableClearance: foreignClearance,
        parallelGap: plan.parallelGap, parallelClearance: plan.parallelClearance});
    }
    return {paths, tubes};
  }

  globalThis.NbCableEditorVirtualCombine = {findRuns, planTubes, denseRunSize: DENSE_RUN_SIZE};
})();
