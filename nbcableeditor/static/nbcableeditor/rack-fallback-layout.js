(() => {
  "use strict";

  const columns = 24;
  const horizontalMargin = 0.035;
  const columnPitch = (1 - 2 * horizontalMargin) / columns;
  const gridTop = 0.38;
  const gridBottom = 0.96;
  const naturalOrder = new Intl.Collator("en", {numeric: true, sensitivity: "base"});

  function comparePorts(a, b) {
    return naturalOrder.compare(a.name, b.name) || naturalOrder.compare(String(a.id), String(b.id));
  }

  function projectDevice(device) {
    if (device.missingLayout !== true) return device;

    const byFace = {front: [], rear: []};
    for (const port of device.ports) {
      const face = port.face === "rear" && device.fullDepth ? "rear" : "front";
      byFace[face].push(port);
    }

    const placed = new Map();
    for (const [face, ports] of Object.entries(byFace)) {
      const rows = Math.ceil(ports.length / columns);
      const columnOffset = (columns - Math.min(columns, ports.length)) / 2;
      for (const [index, port] of ports.sort(comparePorts).entries()) {
        const row = Math.floor(index / columns);
        const column = index % columns + columnOffset;
        placed.set(port.id, {
          ...port,
          face,
          x: horizontalMargin + (column + 0.5) * columnPitch,
          y: gridTop + (row + 0.5) * (gridBottom - gridTop) / rows,
          fallbackLayout: true,
          fallbackRow: row + 1,
        });
      }
    }

    return {...device, ports: device.ports.map(port => placed.get(port.id))};
  }

  function project(data) {
    return {...data, devices: data.devices.map(projectDevice)};
  }

  globalThis.NbCableEditorFallbackLayout = {project};
})();
