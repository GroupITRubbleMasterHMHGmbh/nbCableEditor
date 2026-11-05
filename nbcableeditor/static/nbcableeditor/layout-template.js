(() => {
  "use strict";

  const maxBytes = 512 * 1024;
  const maxItems = 256;
  const maxPorts = 512;
  const fonts = new Set(["sans-serif", "serif", "monospace"]);
  const labelPositions = new Set([
    "top-left", "top", "top-right", "bottom-left", "bottom", "bottom-right", "left", "right", "center",
  ]);
  const portKind = value => value.kind ?? "interface";
  const normalize = (value) => (value ?? "").trim().toLowerCase();

  function fail(path, message) {
    throw new Error(path + " " + message);
  }

  function fields(value, required, optional, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object.");
    for (const key of required) {
      if (!Object.hasOwn(value, key)) fail(path, "is missing " + key + ".");
    }
    for (const key of Object.keys(value)) {
      if (!required.includes(key) && !optional.includes(key)) fail(path, "contains an unsupported field: " + key + ".");
    }
  }

  function string(value, max, path, nonempty = false) {
    if (typeof value !== "string" || (nonempty && !value.trim()) ||
        /[\x00\uD800-\uDFFF]/u.test(value) || [...value].length > max) {
      fail(path, "must be " + (nonempty ? "nonempty " : "") + "text of at most " + max + " characters.");
    }
  }

  function number(value, min, max, path) {
    if (!Number.isFinite(value) || value < min || value > max) {
      fail(path, "must be a number between " + min + " and " + max + ".");
    }
  }

  function array(value, max, path) {
    if (!Array.isArray(value) || value.length > max) fail(path, "must be a list with up to " + max + " entries.");
  }

  function color(value, path) {
    if (value != null && (typeof value !== "string" || value.length !== 7 || !/^#[0-9a-f]{6}$/i.test(value))) {
      fail(path, "must be a six-digit hex color.");
    }
  }

  function artworkText(value, path) {
    string(value.text, 256, path + ".text", true);
    if (!fonts.has(value.font)) fail(path + ".font", "is not supported.");
    number(value.size, 8, 96, path + ".size");
  }

  function validateBox(box, path) {
    number(box.width, 0, 1, path + ".width");
    number(box.height, 0, 1, path + ".height");
    if (!box.width || !box.height || box.x === 1 || box.y === 1 ||
        box.x + box.width > 1 + 1e-9 || box.y + box.height > 1 + 1e-9) {
      fail(path, "must have positive dimensions and fit inside the face.");
    }
  }

  function validateItem(item, path) {
    const position = ["kind", "x", "y"];
    if (item?.kind === "text") {
      fields(item, [...position, "text", "font", "size"], ["color"], path);
      artworkText(item, path);
    } else if (item?.kind === "rectangle") {
      fields(item, [...position, "width", "height"], ["color", "borderColor", "label"], path);
      validateBox(item, path);
      color(item.borderColor, path + ".borderColor");
      if (item.label != null) {
        fields(item.label, ["text", "font", "size", "position"], ["color"], path + ".label");
        artworkText(item.label, path + ".label");
        if (!labelPositions.has(item.label.position)) fail(path + ".label.position", "is not supported.");
        color(item.label.color, path + ".label.color");
      }
    } else {
      fail(path, "must be text or a rectangle.");
    }
    number(item.x, 0, 1, path + ".x");
    number(item.y, 0, 1, path + ".y");
    color(item.color, path + ".color");
  }

  function validateSlots(slots, path, limit, face, isBay = false) {
    array(slots, limit, path);
    const names = new Set();
    slots.forEach((slot, index) => {
      const at = path + "[" + index + "]";
      fields(slot, isBay ? ["name", "x", "y", "width", "height"] : ["name", "x", "y"],
        isBay ? ["moduleFace"] : ["label", "kind"], at);
      string(slot.name, 64, at + ".name", true);
      number(slot.x, 0, 1, at + ".x");
      number(slot.y, 0, 1, at + ".y");
      if (isBay) {
        validateBox(slot, at);
        if (Object.hasOwn(slot, "moduleFace") && !["front", "rear"].includes(slot.moduleFace)) {
          fail(at + ".moduleFace", "must be front or rear.");
        }
      } else {
        if (Object.hasOwn(slot, "label")) string(slot.label, 64, at + ".label");
        if (Object.hasOwn(slot, "kind") && !["interface", face + "-port"].includes(slot.kind)) {
          fail(at + ".kind", "must be interface or " + face + "-port on this face.");
        }
      }
      const key = normalize(slot.name);
      if (names.has(key)) fail(at + ".name", "duplicates another slot on this face.");
      names.add(key);
    });
  }

  function validateFace(face, path, name) {
    fields(face, ["items", "ports"], ["bays"], path);
    array(face.items, maxItems, path + ".items");
    face.items.forEach((item, index) => validateItem(item, path + ".items[" + index + "]"));
    validateSlots(face.ports, path + ".ports", maxPorts, name);
    if (Object.hasOwn(face, "bays")) validateSlots(face.bays, path + ".bays", maxItems - face.items.length, name, true);
  }

  function validateSource(source, index) {
    const path = "Template.sources[" + index + "]";
    string(source, 2048, path, true);
    let url;
    try {
      url = new URL(source);
    } catch {
      fail(path, "must be an HTTPS URL.");
    }
    if (!/^https:\/\/[^/@?#\s]+(?:[/?#][^\s]*)?$/i.test(source) || url.protocol !== "https:" || url.username || url.password) {
      fail(path, "must be an HTTPS URL without credentials.");
    }
  }

  function parse(text) {
    if (typeof text !== "string") fail("Template", "must be JSON text.");
    if (text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes) {
      fail("Template", "must be at most 512 KiB.");
    }
    let template;
    try {
      template = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      fail("Template", "is not valid JSON.");
    }
    fields(template, ["schemaVersion", "kind", "name", "faces"],
      ["$schema", "modelNumber", "description", "sources"], "Template");
    if (template.schemaVersion !== 1) {
      fail("Template", "does not use the supported schema version.");
    }
    if (Object.hasOwn(template, "$schema")) string(template.$schema, 2048, "Template.$schema", true);
    if (template.kind !== "device" && template.kind !== "module") fail("Template.kind", "must be device or module.");
    string(template.name, 128, "Template.name", true);
    if (Object.hasOwn(template, "modelNumber")) string(template.modelNumber, 128, "Template.modelNumber");
    if (Object.hasOwn(template, "description")) string(template.description, 1024, "Template.description");
    if (Object.hasOwn(template, "sources")) {
      array(template.sources, 16, "Template.sources");
      template.sources.forEach(validateSource);
    }
    fields(template.faces, [], ["front", "rear"], "Template.faces");
    const faces = Object.entries(template.faces);
    if (!faces.length) fail("Template.faces", "must contain at least one face.");
    for (const [name, face] of faces) validateFace(face, "Template.faces." + name, name);
    return template;
  }

  function match(slots, ports, namePattern = "") {
    const candidatesForKind = (kind, value) => kind + ":" + normalize(value);
    const assignments = new Map();
    const ambiguous = new Set();
    const taken = new Set();

    for (const field of ["name", "label"]) {
      const byName = new Map();
      for (const port of ports) {
        if (port.id == null || !normalize(port[field])) continue;
        const key = candidatesForKind(portKind(port), port[field]);
        if (!byName.has(key)) byName.set(key, new Set());
        byName.get(key).add(String(port.id));
      }
      const claims = new Map();
      for (const slot of slots) {
        if (assignments.has(slot.name) || ambiguous.has(slot.name)) continue;
        const expected = field === "name" && namePattern
          ? namePattern.replaceAll("{port}", () => slot.name) : slot.name;
        const kind = portKind(slot);
        const candidates = byName.get(candidatesForKind(kind, expected)) ?? byName.get(candidatesForKind(kind, slot.name));
        if (!candidates) continue;
        const [id] = candidates;
        if (candidates.size !== 1 || taken.has(id)) {
          ambiguous.add(slot.name);
          continue;
        }
        if (!claims.has(id)) claims.set(id, []);
        claims.get(id).push(slot.name);
      }
      for (const [id, names] of claims) {
        if (names.length !== 1) {
          for (const name of names) ambiguous.add(name);
        } else {
          assignments.set(names[0], id);
          taken.add(id);
        }
      }
    }
    return {assignments, ambiguous};
  }

  const api = {parse, match};
  globalThis.NbCableEditorLayoutTemplate = api;
  if (typeof module !== "undefined") module.exports = api;
})();
