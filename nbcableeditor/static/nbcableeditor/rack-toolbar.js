(() => {
  "use strict";

  function create({editor, features = {}, defaults = {}, labels = {}}) {
    const panel = editor.querySelector("[data-rack-toolbar-settings]");
    const list = editor.querySelector("[data-rack-toolbar-choices]");
    const scroll = editor.querySelector("[data-scroll]");
    const panHelp = scroll.getAttribute("aria-description");
    const controls = Array.from(editor.querySelectorAll("[data-rack-feature], [data-rack-feature-any]"));
    const choices = new Map();
    let visibility = {};

    const isEnabled = key => features[key] !== false;
    const isVisible = key => isEnabled(key) && (key === "savedViews" || (visibility[key] ?? defaults[key] ?? true));

    for (const [key, text] of Object.entries(labels)) {
      if (key === "savedViews" || !isEnabled(key)) continue;
      const label = document.createElement("label");
      label.className = "form-check";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "form-check-input";
      checkbox.dataset.rackToolbarChoice = key;
      const title = document.createElement("span");
      title.className = "form-check-label";
      title.textContent = text;
      label.append(checkbox, title);
      list.append(label);
      choices.set(key, checkbox);
    }

    function apply(settings) {
      visibility = Object.fromEntries(Object.entries(settings ?? {}).filter(
        ([key, value]) => key !== "savedViews" && typeof value === "boolean",
      ));
      for (const control of controls) {
        const {rackFeature, rackFeatureAny} = control.dataset;
        const visible = rackFeature ? isVisible(rackFeature) : rackFeatureAny.split(" ").some(isVisible);
        control.toggleAttribute("data-rack-feature-hidden", !visible);
        if (!visible && control.tagName === "DETAILS") control.open = false;
      }
      const keys = new Set([...Object.keys(features), ...Object.keys(defaults), ...Object.keys(visibility)]);
      editor.dataset.rackHiddenFeatures = [...keys].filter(key => !isVisible(key)).join(" ");
      scroll.setAttribute("aria-description", isEnabled("zoom") ? panHelp + " Pinch to zoom on a touch screen." : panHelp);
    }

    function snapshot() {
      return {...visibility};
    }

    function openEditor() {
      panel.hidden = choices.size === 0;
      panel.open = false;
      for (const [key, checkbox] of choices) checkbox.checked = isVisible(key);
    }

    function readEditor() {
      const draft = snapshot();
      for (const [key, checkbox] of choices) draft[key] = checkbox.checked;
      return draft;
    }

    apply();
    return {apply, snapshot, openEditor, readEditor, isEnabled, isVisible};
  }

  globalThis.NbCableEditorToolbar = {create};
})();
