(() => {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const quietZone = 4;
  const fields = [
    ["location", "Location", "rackLocation", false],
    ["rackId", "Rack ID", "rackId", false],
    ["rackUrl", "Rack URL", "rackUrl", true],
    ["editorUrl", "Cable Editor URL", "editorUrl", true],
  ];

  function entries(data, options, resolveUrl) {
    return fields.flatMap(([key, label, field, link]) => {
      if (!options[key] || data[field] == null || data[field] === "") return [];
      const value = link ? resolveUrl(data[field]) : String(data[field]);
      return value ? [{label, value, link, qr: link && Boolean(options.qr)}] : [];
    });
  }

  function qrCode(url) {
    try {
      const code = globalThis.qrcode(0, "M");
      code.addData(url);
      code.make();
      return code;
    } catch {
      throw new Error("This URL could not be encoded as a QR code. Try exporting it as text.");
    }
  }

  function forEachDarkModule(code, draw) {
    const count = code.getModuleCount();
    for (let row = 0; row < count; row++) {
      for (let column = 0; column < count; column++) {
        if (code.isDark(row, column)) draw(column + quietZone, row + quietZone);
      }
    }
  }

  function qrGraphic(doc, entry) {
    const code = qrCode(entry.value);
    const size = code.getModuleCount() + 2 * quietZone;
    const svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 " + size + " " + size);
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", entry.label + " QR code");
    const background = doc.createElementNS(SVG, "rect");
    background.setAttribute("width", size);
    background.setAttribute("height", size);
    background.setAttribute("fill", "#fff");
    let path = "";
    forEachDarkModule(code, (column, row) => { path += "M" + column + " " + row + "h1v1h-1z"; });
    const modules = doc.createElementNS(SVG, "path");
    modules.setAttribute("d", path);
    svg.append(background, modules);
    return svg;
  }

  function printHeader(doc, metadata) {
    if (!metadata.length) return null;
    const list = doc.createElement("dl");
    list.className = "re-rack-export-metadata";
    for (const entry of metadata) {
      const row = doc.createElement("div");
      const label = doc.createElement("dt");
      label.textContent = entry.label;
      const value = doc.createElement("dd");
      if (entry.link) {
        const link = doc.createElement("a");
        link.href = entry.value;
        link.textContent = entry.value;
        value.append(link);
      } else {
        value.textContent = entry.value;
      }
      if (entry.qr) value.append(qrGraphic(doc, entry));
      row.append(label, value);
      list.append(row);
    }
    return list;
  }

  function wrapText(context, value, width) {
    const lines = [];
    let line = "";
    for (const word of value.trim().split(/\s+/)) {
      const candidate = line ? line + " " + word : word;
      if (context.measureText(candidate).width <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const character of word) {
        if (line && context.measureText(line + character).width > width) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function imageHeader(doc, width, metadata) {
    if (!metadata.length) return null;
    const context = doc.createElement("canvas").getContext("2d");
    if (!context) throw new Error("The browser could not prepare the export header.");
    const unit = Math.max(1, width / 620);
    const padding = 12 * unit;
    const lineHeight = 16 * unit;
    const gap = 8 * unit;
    const qrSize = Math.min(92 * unit, width * 0.28);
    const font = 12 * unit + "px system-ui, sans-serif";
    context.font = font;
    let top = padding;
    const rows = metadata.map(entry => {
      const lines = wrapText(context, entry.value, width - 2 * padding - (entry.qr ? qrSize + gap : 0));
      const row = {...entry, lines, top};
      top += Math.max(lineHeight * (lines.length + 1), entry.qr ? qrSize : 0) + gap;
      return row;
    });
    return {width, height: top + padding - gap, rows, padding, lineHeight, font, qrSize};
  }

  function paintQr(context, url, left, top, side) {
    const code = qrCode(url);
    const size = code.getModuleCount() + 2 * quietZone;
    const scale = Math.floor(side / size);
    if (!scale) throw new Error("Choose a larger PNG resolution to include the QR codes.");
    const offset = (side - size * scale) / 2;
    const x = Math.round(left + offset);
    const y = Math.round(top + offset);
    context.fillStyle = "#fff";
    context.fillRect(x, y, size * scale, size * scale);
    context.fillStyle = "#000";
    forEachDarkModule(code, (column, row) => context.fillRect(x + column * scale, y + row * scale, scale, scale));
  }

  function paintHeader(context, header, scaleX, scaleY) {
    const {width, height, rows, padding, lineHeight, font, qrSize} = header;
    context.save();
    context.scale(scaleX, scaleY);
    context.fillStyle = "#f5f7fb";
    context.fillRect(0, 0, width, height);
    context.textBaseline = "top";
    for (const row of rows) {
      context.font = "600 " + font;
      context.fillStyle = "#23344a";
      context.fillText(row.label, padding, row.top);
      context.font = font;
      context.fillStyle = row.link ? "#174989" : "#33465f";
      row.lines.forEach((line, index) => context.fillText(line, padding, row.top + (index + 1) * lineHeight));
    }
    context.restore();
    for (const row of rows) {
      if (row.qr) paintQr(context, row.value, (width - padding - qrSize) * scaleX, row.top * scaleY,
        qrSize * Math.min(scaleX, scaleY));
    }
  }

  globalThis.NbCableEditorExportMetadata = {entries, imageHeader, paintHeader, printHeader};
})();
