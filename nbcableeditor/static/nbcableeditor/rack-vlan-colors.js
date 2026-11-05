(() => {
  "use strict";

  function color(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : "";
  }

  function ranges(value) {
    const pieces = value.trim().split(/\s*,\s*/);
    return pieces.map(piece => {
      const match = /^(\d{1,4})(?:\s*-\s*(\d{1,4}))?$/.exec(piece);
      const start = Number(match?.[1]);
      const end = Number(match?.[2] ?? start);
      if (!match || start < 1 || end > 4094 || end < start) {
        throw new Error("Use VLAN IDs from 1 to 4094, separated by commas, or ranges such as 50-70.");
      }
      return [start, end];
    });
  }

  function rule(ids, hex) {
    const fill = color(hex);
    if (!fill) throw new Error("Choose a valid color.");
    return {ids: ids.trim(), color: fill, ranges: ranges(ids)};
  }

  function restore(saved) {
    const rules = [];
    for (const entry of Array.isArray(saved?.rules) ? saved.rules : []) {
      if (typeof entry?.ids !== "string") continue;
      try {
        rules.push(rule(entry.ids, entry.color));
      } catch {
        // Ignore invalid entries left behind by earlier versions or edits to browser storage.
      }
    }
    return {rules, fallback: color(saved?.fallback)};
  }

  function fill(vlan, settings) {
    if (!vlan) return "";
    const match = settings.rules.find(entry => entry.ranges.some(([start, end]) => start <= vlan.vid && vlan.vid <= end));
    return match?.color || color(vlan.color) || settings.fallback;
  }

  globalThis.NbCableEditorVlanColors = {rule, restore, fill};
})();
