(() => {
  "use strict";

  function mountedTop(data, device) {
    if (!Number.isFinite(device.position) || device.position <= 0 ||
        !Number.isFinite(device.height) || device.height <= 0 ||
        (device.face !== "front" && device.face !== "rear")) return null;
    const offset = device.position - (data.startingUnit ?? 1);
    const top = data.descUnits ? offset : data.height - offset - device.height;
    return top >= 0 && top + device.height <= data.height ? top : null;
  }

  function orderPortIds(a, b) {
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a < b ? -1 : Number(a > b);
  }

  function group(data) {
    const result = [];
    for (const device of data.devices) {
      if (mountedTop(data, device) === null) continue;
      // Use image coordinates so row identities are independent of the current zoom.
      const tolerance = 0.07 / Math.max(1, device.height);
      for (const rackFace of ["front", "rear"]) {
        if (rackFace !== device.face && !device.fullDepth) continue;
        const imageFace = rackFace === device.face ? "front" : "rear";
        const placed = device.ports
          .filter(port => port.face === imageFace && Number.isFinite(port.x) && Number.isFinite(port.y))
          .sort((a, b) => a.y - b.y || a.x - b.x || orderPortIds(a.id, b.id));
        const rows = [];
        for (const port of placed) {
          const current = rows.at(-1);
          if (current && port.y - current[0].y <= tolerance) current.push(port);
          else rows.push([port]);
        }
        for (const [index, row] of rows.entries()) {
          const number = index + 1;
          const ports = row.sort((a, b) => a.x - b.x || orderPortIds(a.id, b.id)).map(port => port.id);
          result.push({id: device.id + ":" + rackFace + ":" + number, deviceId: device.id, rackFace, number, ports});
        }
      }
    }
    return result;
  }

  globalThis.NetBoxRackRows = {group, mountedTop};
})();
