(() => {
  "use strict";

  const compactSize = 2;

  function layoutRows(height, devices, {compact = false, focused = false} = {}) {
    const occupied = new Uint8Array(height);
    for (const device of devices) {
      const start = Math.max(0, Math.floor(device.top));
      const end = Math.min(height, Math.ceil(device.top + device.height));
      occupied.fill(1, start, end);
    }
    const rows = [];
    let rowCount = 0;
    for (let row = 0; row < height;) {
      if (focused && !occupied[row]) {
        row++;
        continue;
      }
      let end = row + 1;
      if (compact && !occupied[row]) {
        while (end < height && !occupied[end]) end++;
        if (end - row <= compactSize) end = row + 1;
      }
      const size = Math.min(end - row, compactSize);
      rows.push({start: row, end, top: rowCount, size});
      rowCount += size;
      row = end;
    }
    return {rows, rowCount};
  }

  function verticalAxis(ranges, height) {
    let extraHeight = 0;
    const segments = ranges.map(({top, height: size, count}) => {
      const physicalTop = top + extraHeight;
      const physicalSize = size * count / compactSize;
      extraHeight += physicalSize - size;
      return {top, size, physicalTop, physicalSize};
    });

    function translate(y, inverse) {
      for (const {top, size, physicalTop, physicalSize} of segments) {
        const start = inverse ? physicalTop : top;
        const length = inverse ? physicalSize : size;
        const target = inverse ? top : physicalTop;
        const targetLength = inverse ? size : physicalSize;
        if (y <= start) return y + target - start;
        if (y < start + length) return target + (y - start) * targetLength / length;
      }
      return y + (inverse ? -extraHeight : extraHeight);
    }

    return {
      height: height + extraHeight,
      toPhysical: y => translate(y, false),
      toDisplayed: y => translate(y, true),
    };
  }

  globalThis.NbCableEditorCompactUnits = {layoutRows, verticalAxis};
})();
