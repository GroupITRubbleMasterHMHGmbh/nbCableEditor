(() => {
  "use strict";

  const sortText = new Intl.Collator("en", {numeric: true, sensitivity: "base"});
  const unavailable = {
    deviceKey: "unavailable",
    deviceName: "Outside / unavailable",
    portName: "Port unavailable",
    side: "",
    rackName: "",
  };

  function compareDevice(a, b) {
    return Number(a === unavailable) - Number(b === unavailable) ||
      sortText.compare(a.deviceName, b.deviceName) ||
      sortText.compare(a.rackName ?? "", b.rackName ?? "") ||
      (a.deviceKey < b.deviceKey ? -1 : Number(a.deviceKey > b.deviceKey));
  }

  function comparePort(a, b) {
    return sortText.compare(a.portName, b.portName) ||
      sortText.compare(a.side ?? "", b.side ?? "");
  }

  function deviceKey(endpoint) {
    return endpoint.deviceKey ?? [endpoint.deviceName, endpoint.rackName];
  }

  function groupCables(cables) {
    const groups = new Map();
    for (const cable of cables) {
      const from = cable.a ?? unavailable;
      const to = cable.b ?? unavailable;
      const [a, b] = (compareDevice(from, to) || comparePort(from, to)) > 0 ? [to, from] : [from, to];
      const key = JSON.stringify([deviceKey(a), deviceKey(b)]);
      if (!groups.has(key)) groups.set(key, {a, b, cables: []});
      groups.get(key).cables.push({...cable, a, b});
    }
    const sorted = Array.from(groups.values()).sort((a, b) =>
      compareDevice(a.a, b.a) || compareDevice(a.b, b.b));
    for (const group of sorted) {
      group.cables.sort((a, b) => comparePort(a.a, b.a) || comparePort(a.b, b.b) ||
        sortText.compare(String(a.id), String(b.id)));
    }
    return sorted;
  }

  function element(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function deviceHeading(document, device) {
    const heading = element(document, "th");
    heading.scope = "col";
    heading.append(element(document, "span", "re-rack-export-device-name", device.deviceName));
    if (device.rackName) {
      heading.append(element(document, "span", "re-rack-export-device-rack", device.rackName));
    }
    return heading;
  }

  function portCell(document, endpoint) {
    const cell = element(document, "td");
    cell.append(element(document, "span", "re-rack-export-port-name", endpoint.portName));
    const lastWord = endpoint.portName.trim().split(/\s+/).at(-1).toLowerCase();
    if (endpoint.side && lastWord !== endpoint.side.toLowerCase()) {
      cell.append(element(document, "span", "re-rack-export-port-side", endpoint.side));
    }
    return cell;
  }

  function cableCell(document, cable, groupDetails) {
    const cell = element(document, "td");
    const id = "#" + cable.id;
    if (cable.reference) {
      cell.append(element(document, "span", "re-rack-export-cable-reference", String(cable.reference)));
    }
    cell.append(element(document, "span", "re-rack-export-cable-label", cable.label || id));

    const meta = [cable.label && id, groupDetails.type ? null : cable.type,
      groupDetails.status ? null : cable.status].filter(Boolean);
    const hex = cable.color?.replace(/^#/, "");
    if (/^[0-9a-f]{6}$/i.test(hex ?? "")) {
      const color = "#" + hex.toUpperCase();
      const swatch = element(document, "span", "re-rack-export-color");
      swatch.setAttribute("aria-hidden", "true");
      swatch.style.backgroundColor = color;
      cell.append(swatch);
      meta.push(cable.colorLabel || color);
    }
    if (meta.length) {
      cell.append(element(document, "span", "re-rack-export-cable-meta", meta.join(" · ")));
    }
    return cell;
  }

  function cableGroup(document, group) {
    const table = element(document, "table", "re-rack-export-cable-group");
    table.setAttribute("aria-label", group.a.deviceName + " to " + group.b.deviceName);
    const headings = table.createTHead().insertRow();
    const details = element(document, "th", "", "Cable");
    details.scope = "col";
    details.append(element(document, "span", "re-rack-export-group-count", "(" + group.cables.length + ")"));
    const shared = {};
    if (group.cables.length > 1) {
      for (const field of ["type", "status"]) {
        const value = group.cables[0][field];
        if (value && group.cables.every(cable => cable[field] === value)) shared[field] = value;
      }
    }
    const groupMeta = [shared.type, shared.status].filter(Boolean).join(" · ");
    if (groupMeta) details.append(element(document, "span", "re-rack-export-group-meta", groupMeta));
    headings.append(deviceHeading(document, group.a), deviceHeading(document, group.b), details);
    const body = table.createTBody();
    for (const cable of group.cables) {
      const row = body.insertRow();
      row.dataset.exportCableId = cable.id;
      row.append(portCell(document, cable.a), portCell(document, cable.b), cableCell(document, cable, shared));
    }
    return table;
  }

  function render(document, cables) {
    const section = element(document, "section", "re-rack-export-list");
    const groups = groupCables(cables);
    const header = element(document, "header", "re-rack-export-list-header");
    const cableCount = cables.length + (cables.length === 1 ? " cable" : " cables");
    const pairCount = groups.length + (groups.length === 1 ? " device pair" : " device pairs");
    header.append(element(document, "h2", "re-rack-export-list-heading", "Visible cables"),
      element(document, "p", "re-rack-export-list-count", cableCount + " · " + pairCount));
    section.append(header);
    if (!groups.length) {
      section.append(element(document, "p", "re-rack-export-list-empty", "No cables are visible in this view."));
    }
    for (const group of groups) section.append(cableGroup(document, group));
    return section;
  }

  const styles = `
    .re-rack-export-list {
      color: #172537;
      font: 8.5pt/1.25 system-ui, sans-serif;
      overflow-wrap: anywhere;
      print-color-adjust: exact;
    }
    .re-rack-export-list-header {
      display: flex;
      flex-wrap: wrap;
      gap: 0 3mm;
      align-items: baseline;
      margin-block-end: 2.2mm;
      break-after: avoid-page;
    }
    .re-rack-export-list-heading { margin: 0; font-size: 12pt; }
    .re-rack-export-list-count { margin: 0; color: #48566a; }
    .re-rack-export-list-empty { margin: 0; color: #48566a; }
    .re-rack-export-cable-group {
      width: 100%;
      margin: 0 0 2.8mm;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .re-rack-export-cable-group thead {
      display: table-header-group;
      break-inside: avoid;
      break-after: avoid-page;
    }
    .re-rack-export-cable-group tr { break-inside: avoid; }
    .re-rack-export-cable-group th, .re-rack-export-cable-group td {
      padding: 0.62mm 1.4mm;
      border-bottom: 0.2mm solid #d7dde4;
      text-align: start;
      vertical-align: baseline;
    }
    .re-rack-export-cable-group th {
      background: #edf1f5;
      font-weight: 700;
    }
    .re-rack-export-cable-group th:nth-child(-n + 2) { width: 28%; }
    .re-rack-export-group-count {
      margin-inline-start: 1mm;
      color: #48566a;
      font-size: 7.5pt;
    }
    .re-rack-export-device-rack, .re-rack-export-group-meta { display: block; }
    .re-rack-export-port-name, .re-rack-export-cable-label { font-weight: 600; }
    .re-rack-export-cable-reference {
      display: inline-block;
      min-width: 4mm;
      margin-inline-end: 1.3mm;
      border: .2mm solid #526072;
      border-radius: .8mm;
      text-align: center;
      font-weight: 700;
    }
    .re-rack-export-port-side, .re-rack-export-cable-meta { margin-inline-start: 1mm; }
    .re-rack-export-port-side { text-transform: capitalize; }
    .re-rack-export-device-rack, .re-rack-export-port-side, .re-rack-export-cable-meta, .re-rack-export-group-meta {
      color: #48566a;
      font-size: 7.5pt;
      font-weight: 400;
    }
    .re-rack-export-color {
      display: inline-block;
      box-sizing: border-box;
      width: 2.05mm;
      height: 2.05mm;
      margin-inline-start: 1mm;
      border: 0.2mm solid #526072;
      border-radius: 50%;
    }
  `;

  globalThis.NetBoxRackExportList = {render, styles};
})();
