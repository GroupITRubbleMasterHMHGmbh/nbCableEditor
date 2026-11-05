(() => {
  "use strict";

  function mount(root, {kind, ports, bays, currentFace, apply}) {
    const find = name => root.querySelector("[data-template-" + name + "]");
    const dialog = find("dialog");
    const trigger = root.querySelector("[data-import-template]");
    const catalog = find("catalog");
    const file = find("file");
    const faceChoice = find("face");
    const pattern = find("pattern");
    const rows = find("rows");
    const review = find("review");
    const mapping = find("mapping");
    const summary = find("summary");
    const submit = find("apply");
    const error = find("error");
    const loading = find("loading");
    const {parse, match} = globalThis.NbCableEditorLayoutTemplate;
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, {numeric: true});
    const availablePorts = [...ports].sort(byName);
    const moduleBays = [...bays].sort(byName);
    const kindOf = item => item.kind ?? "interface";
    const kindName = {interface: "Interface", "front-port": "Front port", "rear-port": "Rear port"};
    let template = null;
    let loadId = 0;
    let choices = [];
    let namePattern = "";

    function showError(message = "") {
      error.textContent = message;
      error.hidden = !message;
    }

    function refreshMapping() {
      const counts = new Map();
      const assignments = {ports: new Map(), bays: new Map()};
      for (const {slot, select, group} of choices) {
        if (!select.value) continue;
        assignments[group].set(slot.name, select.value);
        const key = group + ":" + select.value;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      let conflicted = false;
      for (const {select, state, ambiguous, group} of choices) {
        const duplicate = (counts.get(group + ":" + select.value) ?? 0) > 1;
        if (duplicate) conflicted = true;
        state.textContent = duplicate ? "Already assigned" : select.value ? "Mapped" : ambiguous ? "Needs review" : "Unmapped";
        state.classList.toggle("text-danger", duplicate);
        if (duplicate) select.setAttribute("aria-invalid", "true");
        else select.removeAttribute("aria-invalid");
      }
      const {ports, bays = []} = template.faces[faceChoice.value];
      const totals = [];
      if (ports.length) {
        const kinds = new Set(ports.map(kindOf));
        const available = availablePorts.filter(port => kinds.has(kindOf(port))).length;
        const label = kinds.size === 1 && kinds.has("interface") ? "interfaces" : "ports";
        totals.push(assignments.ports.size + " of " + ports.length + " port slots mapped · " + available + " available " + label + ".");
      }
      if (bays.length) totals.push(assignments.bays.size + " of " + bays.length + " bay slots mapped · " + moduleBays.length + " available module bays.");
      summary.textContent = totals.join(" ") || "This face contains artwork only.";
      submit.disabled = conflicted;
      return assignments;
    }

    function mappingRows(slots, targets, group) {
      const isBay = group === "bays";
      const {assignments, ambiguous} = match(slots, targets, isBay ? "" : namePattern);
      const byKind = new Map();
      for (const target of targets) {
        const kind = kindOf(target);
        if (!byKind.has(kind)) byKind.set(kind, new Map());
        const {id, name, label} = target;
        byKind.get(kind).set(String(id), label && label !== name ? name + " · " + label : name);
      }
      return slots.map(slot => {
        const names = byKind.get(kindOf(slot)) ?? new Map();
        const row = document.createElement("tr");
        const label = document.createElement("th");
        label.scope = "row";
        label.textContent = isBay ? "Bay " + slot.name : slot.label && slot.label !== slot.name ? slot.name + " · " + slot.label : slot.name;
        const field = document.createElement("td");
        const select = document.createElement("select");
        select.className = "form-select form-select-sm no-ts";
        select.dataset[isBay ? "templateBay" : "templatePort"] = slot.name;
        select.setAttribute("aria-label", (isBay ? "Module bay" : kindName[kindOf(slot)]) + " for slot " + slot.name);
        select.append(new Option("Leave unmapped", ""));
        const mapped = assignments.get(slot.name);
        if (mapped) select.append(new Option(names.get(mapped), mapped, false, true));
        // A high-density device can have hundreds of interfaces. Expand each picker on demand.
        select.addEventListener("focus", () => {
          const selected = select.value;
          select.replaceChildren(new Option("Leave unmapped", ""),
            ...Array.from(names, ([id, name]) => new Option(name, id)));
          select.value = selected;
        }, {once: true});
        field.append(select);
        const state = document.createElement("td");
        state.className = "small text-secondary";
        row.append(label, field, state);
        return {slot, row, select, state, group, ambiguous: ambiguous.has(slot.name)};
      });
    }

    function showFace(keepBayChoices = false) {
      const {ports, bays = []} = template.faces[faceChoice.value];
      const bayChoices = keepBayChoices ? choices.filter(choice => choice.group === "bays") : mappingRows(bays, moduleBays, "bays");
      choices = [...mappingRows(ports, availablePorts, "ports"), ...bayChoices];
      rows.replaceChildren(...choices.map(choice => choice.row));
      mapping.hidden = !choices.length;
      const kinds = new Set(ports.map(kindOf));
      find("pattern-controls").hidden = !availablePorts.some(port => kinds.has(kindOf(port)));
      find("slot-heading").textContent = bays.length ? "Template slot" : "Port slot";
      const target = bays.length ? "component" : kinds.size === 1 && kinds.has("interface") ? "interface" : "port";
      find("target-heading").textContent = "NetBox " + target;
      find("pattern-label").textContent = kinds.size === 1 && kinds.has("interface") ? "Interface name pattern" : "Port name pattern";
      mapping.scrollTop = 0;
      showError();
      refreshMapping();
    }

    async function load(read) {
      const id = ++loadId;
      template = null;
      namePattern = pattern.value = "";
      review.hidden = true;
      submit.disabled = true;
      showError();
      loading.textContent = read ? "Reading template…" : "";
      if (!read) return;
      try {
        const text = await read();
        if (!dialog.open || id !== loadId) return;
        const parsed = parse(text);
        if (parsed.kind !== kind) throw new Error("Choose a template for this " + kind + " type.");
        template = parsed;
        find("name").textContent = parsed.name + (parsed.modelNumber ? " · " + parsed.modelNumber : "");
        find("description").textContent = parsed.description ?? "";
        const faces = Object.keys(parsed.faces);
        faceChoice.replaceChildren(...faces.map(face => new Option(face === "front" ? "Front" : "Rear", face)));
        if (faces.includes(currentFace())) faceChoice.value = currentFace();
        showFace();
        review.hidden = false;
      } catch (failure) {
        if (id === loadId && dialog.open) showError(failure.message || "Unable to read the template.");
      } finally {
        if (id === loadId) loading.textContent = "";
      }
    }

    function loadCatalog() {
      file.value = "";
      const url = catalog.value;
      load(url && (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Unable to load the built-in template (HTTP " + response.status + ").");
        return response.text();
      }));
    }

    function openDialog(option) {
      if (catalog) catalog.value = option?.value ?? "";
      file.value = "";
      load();
      dialog.showModal();
      if (option) loadCatalog();
    }

    trigger.addEventListener("click", () => openDialog());
    catalog?.addEventListener("change", loadCatalog);
    file.addEventListener("change", () => {
      if (catalog) catalog.value = "";
      const selected = file.files[0];
      load(selected && (() => {
        if (selected.size > 512 * 1024) throw new Error("Use a JSON template of 512 KiB or less.");
        return selected.text();
      }));
    });
    faceChoice.addEventListener("change", () => showFace());
    find("remap").addEventListener("click", () => {
      const value = pattern.value.trim();
      if (value && !value.includes("{port}")) {
        showError("Include {port} in the name pattern, or leave it blank to use slot names.");
        pattern.focus();
        return;
      }
      namePattern = value;
      showFace(true);
    });
    pattern.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      find("remap").click();
    });
    rows.addEventListener("change", () => {
      showError();
      refreshMapping();
    });
    find("cancel").addEventListener("click", () => dialog.close());
    find("form").addEventListener("submit", event => {
      event.preventDefault();
      if (!template || submit.disabled) return;
      try {
        apply(faceChoice.value, template.faces[faceChoice.value], refreshMapping());
        dialog.close();
      } catch (failure) {
        showError(failure.message);
      }
    });

    const requested = new URLSearchParams(window.location.search).get("template");
    if (requested) {
      const option = Array.from(catalog?.options ?? []).find(candidate => candidate.dataset.templateSlug === requested);
      if (option) openDialog(option);
    }
  }

  globalThis.NbCableEditorLayoutTemplateDialog = {mount};
})();
