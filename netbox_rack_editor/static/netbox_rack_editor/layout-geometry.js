(() => {
  "use strict";

  const snapDistancePx = 7;
  const coordinateTolerance = 1e-9;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function bounds(points, axis) {
    let min = 1;
    let max = 0;
    for (const point of points) {
      min = Math.min(min, point[axis]);
      max = Math.max(max, point[axis]);
    }
    return [min, max];
  }

  function gridAxis([min, max], count, minimumStep) {
    if (count === 1) return {start: (min + max) / 2, step: 0};
    const span = Math.min(1, Math.max(max - min, (count - 1) * minimumStep));
    return {start: clamp((min + max - span) / 2, 0, 1 - span), step: span / (count - 1)};
  }

  function alignPorts(points, mode, columns, minimumStep = {x: .08, y: .08}) {
    const result = points.map(point => ({...point}));
    if (result.length < 2) return result;

    const xBounds = bounds(points, "x");
    const yBounds = bounds(points, "y");
    if (mode === "row" || mode === "column") {
      const axis = mode === "row" ? "y" : "x";
      const crossAxis = axis === "y" ? "x" : "y";
      const [min, max] = mode === "row" ? yBounds : xBounds;
      for (const point of result) point[axis] = (min + max) / 2;
      const order = [...points.keys()].sort((a, b) => points[a][crossAxis] - points[b][crossAxis] ||
        points[a][axis] - points[b][axis]);
      if (order.some((id, index) => index &&
          points[id][crossAxis] - points[order[index - 1]][crossAxis] <= coordinateTolerance)) {
        // If two ports would land on top of each other, spread the line in its existing order.
        const crossBounds = mode === "row" ? xBounds : yBounds;
        const {start, step} = gridAxis(crossBounds, points.length, minimumStep[crossAxis]);
        for (const [index, id] of order.entries()) result[id][crossAxis] = clamp(start + index * step, 0, 1);
      }
      return result;
    }
    if (mode !== "grid") return result;

    const columnCount = Number.isInteger(columns) && columns > 0 ? Math.min(columns, points.length)
      : Math.ceil(Math.sqrt(points.length));
    const rowCount = Math.ceil(points.length / columnCount);
    const horizontal = gridAxis(xBounds, columnCount, minimumStep.x);
    const vertical = gridAxis(yBounds, rowCount, minimumStep.y);
    const order = points.map((_, index) => index).sort((a, b) => points[a].y - points[b].y || points[a].x - points[b].x);
    for (let row = 0; row < rowCount; row++) {
      // Assign top-to-bottom bands first, then maintain left-to-right order in each band.
      const band = order.slice(row * columnCount, (row + 1) * columnCount)
        .sort((a, b) => points[a].x - points[b].x);
      for (const [column, index] of band.entries()) {
        result[index].x = clamp(horizontal.start + horizontal.step * column, 0, 1);
        result[index].y = clamp(vertical.start + vertical.step * row, 0, 1);
      }
    }
    return result;
  }

  function snapAxis(value, size, step, targets, anchors, min, max) {
    const origin = clamp(value, min, max);
    if (!(size > 0)) return {value: origin, guide: null};

    let best = null;
    let closestPx = Infinity;
    for (const offset of anchors) {
      for (const target of targets) {
        const candidate = target - offset;
        if (candidate < min - coordinateTolerance || candidate > max + coordinateTolerance) continue;
        const distancePx = Math.abs(candidate - origin) * size;
        if (distancePx > snapDistancePx || distancePx >= closestPx) continue;
        best = {value: clamp(candidate, min, max), guide: target};
        closestPx = distancePx;
      }
    }
    if (best) return best;

    if (step > 0) {
      const interval = step / size;
      const first = Math.ceil((min - coordinateTolerance) / interval);
      const last = Math.floor((max + coordinateTolerance) / interval);
      if (first <= last) {
        const index = clamp(Math.round(origin / interval), first, last);
        return {value: clamp(index * interval, min, max), guide: null};
      }
    }
    return {value: origin, guide: null};
  }

  function snapPoint(point, {
    width, height, step, grid, objects, targets = {}, anchors = {}, minX = 0, maxX = 1, minY = 0, maxY = 1,
  }) {
    const spacing = grid ? step : 0;
    const x = snapAxis(point.x, width, spacing, objects ? targets.x ?? [] : [], anchors.x ?? [0], minX, maxX);
    const y = snapAxis(point.y, height, spacing, objects ? targets.y ?? [] : [], anchors.y ?? [0], minY, maxY);
    return {x: x.value, y: y.value, guideX: x.guide, guideY: y.guide};
  }

  const geometry = {alignPorts, snapPoint};
  if (typeof module === "object" && module.exports) module.exports = geometry;
  else globalThis.NetBoxRackLayoutGeometry = geometry;
})();
