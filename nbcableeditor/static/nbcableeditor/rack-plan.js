(() => {
  "use strict";

  globalThis.NbCableEditorPlan = ({editor, data, ports, portIdsByDataset, cables, get, node, button, httpUrl, requestMutation,
    describe, setError, refresh, redraw, refreshRoutes, onViewChange, canEnter, locatePort}) => {
    const config = data.planning;
    if (!config?.url || !get("plan-select")) return null;
    const selector = get("plan-select");
    const view = get("plan-view");
    const bar = get("plan-bar");
    const message = get("plan-message");
    const opacity = get("plan-opacity");
    const dialog = get("plan-dialog");
    const title = get("plan-dialog-title");
    const content = get("plan-dialog-content");
    const errorBox = get("plan-error");
    const preferencesKey = "nbcableeditor:planning:" + location.pathname;
    let preferences = {};
    try {
      preferences = JSON.parse(localStorage.getItem(preferencesKey)) || {};
    } catch {
      // Planning can run with browser storage disabled.
    }
    opacity.value = preferences.opacity ?? opacity.value;
    let plans = [];
    let plan = null;
    let source = null;
    let sourceConnection = null;
    let target = null;
    let pointer = null;
    let pending = false;
    let selectSequence = 0;
    let operationsByPort = new Map();
    let changesByCable = new Map();
    let draftCable = null;

    const inView = () => Boolean(plan && view.value !== "stock");
    const editing = () => inView() && plan.canEdit && !plan.applied;
    const operations = () => plan?.operations ?? [];
    const portStatuses = {conflict: "Conflicting planned connections", connected: "Connected in plan",
      released: "Free after applying the plan"};
    const planUrl = id => new URL(encodeURIComponent(id) + "/", httpUrl(config.url)).href;
    const portDescription = id => ports.has(id) ? describe(ports.get(id)) : id || "Outside this rack";
    const originalEnd = (operation, end) => operation.before?.[end] ?? cables.get(operation.cable_id)?.[end];
    const operationName = {add: "Connect", move: "Move", delete: "Unplug"};
    const addButton = (label, action, style = "outline-secondary") => {
      const control = button("btn btn-sm btn-" + style, label);
      control.addEventListener("click", action);
      return control;
    };
    const choice = (select, options) => {
      for (const [value, label] of options) select.add(new Option(label, value));
      return select;
    };
    const selectInput = options => choice(node("select", "form-select form-select-sm no-ts"), options);
    const input = (type, value = "") => {
      const control = node("input", "form-control form-control-sm");
      control.type = type;
      control.value = value ?? "";
      return control;
    };
    const field = (label, control) => {
      const wrapper = node("label", "re-rack-plan-field");
      wrapper.append(node("span", "small fw-semibold", label), control);
      return wrapper;
    };
    const description = text => node("p", "text-muted small mb-2", text);

    function notify(text, error = false) {
      message.hidden = !text;
      message.textContent = text;
      message.classList.toggle("text-danger", error);
      message.classList.toggle("text-muted", !error);
    }

    function remember() {
      try {
        localStorage.setItem(preferencesKey, JSON.stringify({id: plan?.id, view: view.value, opacity: opacity.value}));
      } catch {
        // The current view remains usable.
      }
    }

    function updateOpacity() {
      get("plan-opacity-value").textContent = opacity.value + "%";
      editor.style.setProperty("--re-rack-stock-opacity", Number(opacity.value) / 100);
      remember();
    }

    function syncPlans() {
      selector.replaceChildren(new Option("Select plan", ""));
      for (const item of plans) selector.add(new Option(item.name + (item.applied ? " · Applied" : ""), item.id));
      selector.value = plan?.id ?? "";
      for (const option of view.options) option.disabled = option.value !== "stock" && !plan;
      if (!plan) view.value = "stock";
      selector.disabled = pending;
    }

    function refreshState() {
      const previousMode = editor.dataset.planView;
      operationsByPort = new Map();
      changesByCable = new Map();
      for (const operation of operations()) {
        if (operation.restricted) continue;
        if (operation.cable_id != null) changesByCable.set(operation.cable_id, operation);
        if (operation.action === "delete") continue;
        for (const id of [operation.a, operation.b]) {
          if (!operationsByPort.has(id)) operationsByPort.set(id, []);
          operationsByPort.get(id).push(operation);
        }
      }
      syncPlans();
      editor.dataset.planView = view.value;
      bar.hidden = !inView();
      get("plan-name").textContent = plan?.name ?? "";
      get("plan-indicator").textContent = plan?.applied ? "Applied" : "Draft";
      get("plan-opacity-control").hidden = view.value !== "mixed";
      get("plan-changes").textContent = "Changes (" + operations().length + ")";
      get("plan-apply").disabled = !editing() || operations().length === 0;
      get("plan-port-actions").disabled = !editing() || !source;
      updateOpacity();
      if (previousMode !== view.value) onViewChange();
      refresh();
      refreshRoutes();
    }

    function withPlan(data) {
      plan = data;
      if (plan) {
        plans = [...plans.filter(item => item.id !== plan.id), plan]
          .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
      }
      refreshState();
    }

    async function fetchJson(endpoint) {
      const url = httpUrl(endpoint);
      if (!url) throw new Error("The planning URL is unavailable.");
      const response = await fetch(url, {credentials: "same-origin", headers: {Accept: "application/json"}});
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "NetBox could not load the planning data.");
      return payload;
    }

    async function load(id, mode = "mixed") {
      const sequence = ++selectSequence;
      cancel();
      if (!id) {
        withPlan(null);
        notify("");
        return;
      }
      if (mode !== "stock" && !canEnter()) {
        syncPlans();
        notify("Apply or discard the pending live batch before opening the plan.", true);
        return;
      }
      notify("Loading plan…");
      try {
        const result = await fetchJson(planUrl(id));
        if (sequence !== selectSequence) return;
        view.value = mode;
        withPlan(result.plan);
        notify("");
      } catch (error) {
        if (sequence !== selectSequence) return;
        syncPlans();
        notify(error.message, true);
      }
    }

    function showDialog(label) {
      title.textContent = label;
      content.replaceChildren();
      setError(errorBox);
      if (!dialog.open) dialog.showModal();
      return content;
    }

    function actions(...buttons) {
      const row = node("div", "re-rack-dialog-actions re-rack-plan-dialog-actions");
      row.append(...buttons);
      return row;
    }

    function formWith(...children) {
      const form = node("form", "re-rack-plan-form");
      form.append(...children);
      return form;
    }

    function submitted(form, run) {
      form.addEventListener("submit", event => {
        event.preventDefault();
        execute(run, form);
      });
    }

    async function execute(run, scope = content) {
      if (pending) return;
      pending = true;
      selector.disabled = true;
      const controls = [...scope.querySelectorAll("button, input, select")].filter(control => !control.disabled);
      for (const control of controls) control.disabled = true;
      setError(errorBox);
      try {
        await run();
      } catch (error) {
        if (dialog.open) setError(errorBox, error.message);
        else notify(error.message, true);
      } finally {
        pending = false;
        selector.disabled = false;
        for (const control of controls) if (control.isConnected) control.disabled = false;
      }
    }

    function submitButton(label, style = "primary") {
      const control = button("btn btn-sm btn-" + style, label);
      control.type = "submit";
      return control;
    }

    function write(body, current = plan) {
      return requestMutation(planUrl(current.id), {revision: current.revision, ...body});
    }

    async function save(changes) {
      const {plan: updated} = await write({action: "save", ...changes});
      withPlan(updated);
    }

    function showManagement() {
      showDialog("Rack wiring plans");
      content.append(description("Plans are shared in this rack. Draft changes leave the live wiring untouched until you apply them."));
      const list = node("div", "list-group");
      for (const item of plans) {
        const row = node("div", "list-group-item re-rack-plan-manage-row");
        const caption = node("span", "fw-semibold", item.name);
        caption.append(node("span", "badge bg-secondary-lt ms-2", item.applied ? "Applied" : "Draft"));
        row.append(caption, addButton("Open", () => { dialog.close(); void load(item.id); }));
        list.append(row);
      }
      if (plans.length) content.append(list);
      else content.append(description("This rack has no wiring plans yet."));
      const buttons = [];
      if (config.canAdd) buttons.push(addButton("New plan", () => showNameForm("create"), "primary"));
      if (plan) {
        if (plan.canEdit && !plan.applied) buttons.push(addButton("Rename", () => showNameForm("rename")));
        if (config.canAdd) buttons.push(addButton(plan.applied ? "New draft from profile" : "Duplicate", () => showNameForm("duplicate")));
        if (plan.canEdit && !plan.applied) buttons.push(addButton("Routing profile", showProfile));
        if (plan.canDelete) buttons.push(addButton("Delete", confirmDelete, "outline-danger"));
      }
      if (config.canMeasure) buttons.push(addButton("Rack measurements", showMeasurements));
      content.append(actions(...buttons));
    }

    function showNameForm(action) {
      const labels = {create: "New plan", rename: "Rename plan",
        duplicate: plan?.applied ? "New draft from profile" : "Duplicate plan"};
      showDialog(labels[action]);
      const name = input("text", action === "duplicate" ? plan.name + " copy" : action === "rename" ? plan.name : "");
      name.required = true;
      name.maxLength = 120;
      const form = formWith(field("Plan name", name));
      let profile;
      if (action === "create" && config.profiles?.length) {
        profile = selectInput(config.profiles.map(item => [item.id, item.name]));
        profile.value = config.defaultProfile || profile.value;
        form.append(field("Routing profile", profile));
      }
      form.append(actions(addButton("Back", showManagement), submitButton(labels[action])));
      submitted(form, async () => {
        let result;
        if (action === "rename") result = await write({action: "save", name: name.value.trim()});
        else if (action === "duplicate") result = await write({action, name: name.value.trim()});
        else result = await requestMutation(config.url, {action, name: name.value.trim(), profileId: profile?.value});
        if (!result.plan?.operations) result = await fetchJson(planUrl(result.plan.id));
        view.value = canEnter() ? "mixed" : "stock";
        withPlan(result.plan);
        dialog.close();
        notify("Plan saved.");
      });
      content.append(form);
      name.focus();
      name.select();
    }

    function confirmDelete() {
      showDialog("Delete plan");
      content.append(description(plan.applied
        ? "Delete “" + plan.name + "” from this rack? Use Cable history to undo the wiring changes."
        : "Delete “" + plan.name + "” and all of its draft changes?"));
      content.append(actions(addButton("Cancel", showManagement), addButton("Delete plan", () => execute(async () => {
        await write({action: "delete"});
        plans = plans.filter(item => item.id !== plan.id);
        withPlan(null);
        dialog.close();
        notify("Plan deleted.");
      }), "danger")));
    }

    const profileFields = [
      ["strategy", "Routing strategy", [["prefer_direct", "Prefer direct"], ["prefer_channel", "Prefer side channel"],
        ["always_channel", "Always use side channel"]]],
      ["channels", "Available channels", [["both", "Both"], ["left", "Left only"], ["right", "Right only"]]],
      ["channel_selection", "Channel selection", [["shortest", "Shortest"], ["left", "Prefer left"],
        ["right", "Prefer right"], ["balanced", "Balance sides"]]],
      ["reserve_percent", "Reserve (%)"], ["connector_lead_mm", "Straight connector lead (mm)"],
      ["left_channel_offset_mm", "Left channel offset (mm)"], ["right_channel_offset_mm", "Right channel offset (mm)"],
      ["direct_max_mm", "Direct distance limit (mm)"], ["balance_tolerance_mm", "Balance tolerance (mm)"],
      ["channel_preference_mm", "Extra distance allowed for preferred channel (mm)"],
      ["allow_direct_gap", "Allow direct route across rack gaps", "checkbox"], ["direct_gap_max_u", "Maximum gap (U)"],
      ["allow_direct_intervening", "Allow direct route across devices", "checkbox"],
      ["direct_intervening_max_devices", "Maximum intervening devices"],
    ];
    const geometryFields = [
      ["panel_width_mm", "Measured panel width (mm)"], ["mounting_depth_mm", "Front-to-rear mounting depth (mm)"],
      ["left_channel_offset_mm", "Measured left channel offset (mm)"], ["right_channel_offset_mm", "Measured right channel offset (mm)"],
    ];

    function parameterFields(form, values, definitions) {
      const controls = new Map();
      const grid = node("div", "re-rack-plan-fields");
      for (const [key, label, type] of definitions) {
        const control = Array.isArray(type) ? selectInput(type) : input(type ?? "number");
        if (control.type === "checkbox") {
          control.className = "form-check-input";
          control.checked = Boolean(values[key]);
          grid.append(field(label, control));
        } else {
          if (control.type === "number") {
            control.min = 0;
            control.step = "any";
          }
          control.value = values[key] ?? (Array.isArray(type) ? type[0][0] : "");
          grid.append(field(label, control));
        }
        controls.set(key, control);
      }
      form.append(grid);
      return () => Object.fromEntries([...controls].map(([key, control]) => [
        key, control.type === "checkbox" ? control.checked : control.type !== "number" ? control.value
          : control.value === "" ? null : Number(control.value),
      ]));
    }

    function showProfile() {
      showDialog("Plan routing profile");
      const profile = plan.profile;
      const options = profile?.options ?? {};
      const form = formWith(description("These overrides apply to this plan. Global profiles stay available for new plans."));
      const readProfile = parameterFields(form, options, profileFields);
      const readRadii = parameterFields(form, options.bend_radius_mm ?? {}, [
        ["default", "Default bend radius (mm)"],
        ...data.cableTypes.filter(type => type.value).map(type => [type.value, type.label + " bend radius (mm)"]),
      ]);
      form.append(actions(addButton("Back", showManagement), submitButton("Save profile")));
      submitted(form, async () => {
        const values = Object.fromEntries(Object.entries(readProfile()).filter(([, value]) => value !== null));
        const radii = Object.fromEntries(Object.entries(readRadii()).filter(([, value]) => value !== null));
        await save({profile: {...profile, options: {...options, ...values, bend_radius_mm: radii}}});
        showManagement();
      });
      content.append(form);
    }

    let rackGeometry = config.geometry ?? {};
    function showMeasurements() {
      showDialog("Rack measurements");
      const form = formWith(description("Supply measured dimensions to refine the cable calculator. Leave a field empty to use its fallback."));
      const values = parameterFields(form, rackGeometry, geometryFields);
      form.append(actions(addButton("Back", showManagement), submitButton("Save measurements")));
      submitted(form, async () => {
        const geometry = Object.fromEntries(Object.entries(values()).filter(([, value]) => value !== null));
        const result = await requestMutation(config.url, {action: "geometry", geometry});
        rackGeometry = result.geometry ?? geometry;
        showManagement();
      });
      content.append(form);
    }

    function plannedPort(id) {
      const port = ports.get(id);
      if (!port || !inView()) return "";
      const proposed = operationsByPort.get(id)?.length ?? 0;
      if (plan.applied) return proposed ? "connected" : "";
      const original = port.cableId != null && !changesByCable.has(port.cableId);
      if (proposed > 1 || (proposed && original)) return "conflict";
      if (proposed) return "connected";
      if (port.cableId != null && !original) return "released";
      return "";
    }

    function markPorts() {
      for (const marker of editor.querySelectorAll("[data-port]")) {
        const id = portIdsByDataset.get(marker.dataset.port);
        const state = plannedPort(id);
        const meta = marker.querySelector(".re-rack-port-meta");
        if (state) {
          if (!marker.dataset.inventoryLabel) marker.dataset.inventoryLabel = marker.getAttribute("aria-label");
          marker.dataset.planPort = state;
          const text = portStatuses[state];
          if (meta) meta.dataset.planStatus = text;
          marker.setAttribute("aria-label", marker.dataset.inventoryLabel + " · " + text);
        } else if (marker.dataset.planPort) {
          delete marker.dataset.planPort;
          if (meta) delete meta.dataset.planStatus;
          marker.setAttribute("aria-label", marker.dataset.inventoryLabel);
          delete marker.dataset.inventoryLabel;
        }
        marker.toggleAttribute("data-plan-source", inView() && source?.id === id);
        marker.toggleAttribute("data-plan-target", inView() && target?.id === id);
        if (inView()) marker.setAttribute("aria-pressed", String(source?.id === id));
      }
      get("plan-port-actions").disabled = !editing() || !source;
    }

    function cableAtPort(port) {
      const next = operationsByPort.get(port.id) ?? [];
      const current = cables.get(port.cableId);
      const changed = current && changesByCable.get(current.id);
      if (next.length > 1 || (next.length && current && !changed)) return null;
      if (next.length) return next[0];
      if (changed) return {action: "released"};
      return current ? {action: "stock", cable: current, a: current.a, b: current.b} : {action: "free"};
    }

    function canUse(port) {
      return port && !port.blocked && ["free", "cabled"].includes(port.occupancy);
    }

    function canDrag(port) {
      if (!editing() || pending || !canUse(port)) return false;
      const connection = port.id === source?.id && sourceConnection || cableAtPort(port);
      if (!connection) return false;
      if (connection.action === "stock") return connection.cable.editable;
      if (["free", "released"].includes(connection.action)) return data.canAdd;
      return true;
    }

    function canTarget(port) {
      if (!source || !canUse(port) || source.id === port.id) return false;
      const connection = sourceConnection ?? cableAtPort(source);
      return connection && ![connection.a, connection.b].includes(port.id);
    }

    function chooseSource(port, connection = cableAtPort(port)) {
      if (!editing() || pending || !port) return;
      source = port;
      sourceConnection = connection;
      const moving = connection && connection.a && connection.b;
      const detail = canDrag(port) ? (moving ? "Choose the new port for this cable end." : "Choose the other port.")
        : "Open Port actions to inspect available changes.";
      notify(portDescription(port.id) + ". " + detail);
      markPorts();
    }

    function cancel() {
      source = null;
      sourceConnection = null;
      target = null;
      const captured = pointer?.id;
      pointer = null;
      if (captured != null && editor.hasPointerCapture(captured)) editor.releasePointerCapture(captured);
      markPorts();
      refresh();
    }

    function newId() {
      return globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + "-" + Math.random().toString(36).slice(2);
    }

    function changeFromStock(cable, action) {
      return {id: newId(), action, cable_id: cable.id, before: {a: cable.a, b: cable.b}};
    }

    function changesWith(operation) {
      const next = [...operations()];
      const index = next.findIndex(item => item.id === operation.id);
      if (index < 0) next.push(operation);
      else next[index] = operation;
      return next;
    }

    async function stage(operation, notice) {
      const next = changesWith(operation);
      const reverted = operation.action === "move" && operation.a === originalEnd(operation, "a") &&
        operation.b === originalEnd(operation, "b");
      await save({operations: reverted ? next.filter(item => item.id !== operation.id) : next});
      cancel();
      dialog.close();
      notify(notice);
    }

    function showAdd(operation, recommendation) {
      showDialog(operation.id ? "Edit planned cable" : "Plan a new cable");
      const type = selectInput([["", "Unspecified"], ...data.cableTypes.filter(type => type.value)
        .map(type => [type.value, type.label])]);
      const color = input("text", operation.color ? "#" + operation.color.replace(/^#/, "") : "");
      color.placeholder = "#2563EB";
      color.pattern = "#?[0-9A-Fa-f]{6}";
      color.maxLength = 7;
      color.spellcheck = false;
      const label = input("text", operation.label);
      label.maxLength = 100;
      const length = input("number", operation.length);
      length.min = ".01";
      length.max = "999999.99";
      length.step = ".01";
      length.placeholder = "Optional";
      const unit = selectInput(data.cableLengthUnits.map(item => [item.value, item.label]));
      let previous = {};
      try {
        previous = JSON.parse(localStorage.getItem("nbcableeditor:cable-defaults")) ?? {};
      } catch {
        // Local defaults are optional.
      }
      type.value = operation.type ?? previous.type ?? "";
      if (!operation.id && previous.color) color.value = "#" + previous.color.replace(/^#/, "");
      unit.value = operation.length_unit || "m";
      const form = formWith(description(portDescription(operation.a) + " → " + portDescription(operation.b)));
      const fields = node("div", "re-rack-plan-fields");
      fields.append(field("Cable type", type), field("Color", color), field("Label", label),
        field("Confirmed length", length), field("Length unit", unit));
      form.append(fields);
      const palette = get("create-form").querySelector(".re-rack-palette")?.cloneNode(true);
      if (palette) {
        palette.classList.add("mb-2");
        palette.addEventListener("click", event => {
          const swatch = event.target.closest("[data-color-value]");
          if (swatch) color.value = swatch.dataset.colorValue;
        });
        form.append(palette);
      }
      form.append(description("Leave length empty to defer the decision. The cable calculator suggests a catalog length in the review."));
      if (recommendation != null) {
        form.append(addButton("Use recommended " + formatLength(recommendation), () => {
          const meters = recommendation % 10 === 0;
          length.value = recommendation / (meters ? 1000 : 10);
          unit.value = meters ? "m" : "cm";
          length.focus();
        }));
      }
      form.append(actions(addButton("Cancel", () => dialog.close()), submitButton("Save to plan")));
      submitted(form, async () => {
        await stage({...operation, id: operation.id || newId(), action: "add", type: type.value,
          color: color.value.replace(/^#/, ""), label: label.value.trim(), length: length.value,
          length_unit: length.value ? unit.value : ""}, "Planned cable saved.");
        try {
          localStorage.setItem("nbcableeditor:cable-defaults", JSON.stringify({type: type.value, color: color.value.replace(/^#/, "")}));
        } catch {
          // The plan is already saved.
        }
      });
      content.append(form);
      type.focus();
    }

    function showMove(from, to, connection) {
      const operation = connection.action === "stock"
        ? {...changeFromStock(connection.cable, "move"), a: connection.a, b: connection.b}
        : {...connection};
      const end = operation.a === from.id ? "a" : "b";
      const other = end === "a" ? "b" : "a";
      operation[end] = to.id;
      showDialog("Plan a cable move");
      const form = formWith(description(portDescription(from.id) + " → " + portDescription(to.id)),
        description("Other end stays at " + portDescription(operation[other]) + "."));
      if (to.occupancy !== "free" && plannedPort(to.id) !== "released") {
        form.append(description("Resolve any remaining target occupancy before applying this plan."));
      }
      const submit = submitButton("Save to plan");
      form.append(actions(addButton("Cancel", () => dialog.close()), submit));
      submitted(form, () => stage(operation, "Planned cable move saved."));
      content.append(form);
      submit.focus();
    }

    function useTarget(port) {
      if (!canTarget(port)) {
        notify("Choose another supported port.", true);
        return;
      }
      const connection = sourceConnection ?? cableAtPort(source);
      if (connection.action === "released" || connection.action === "free") showAdd({a: source.id, b: port.id});
      else showMove(source, port, connection);
    }

    function confirmUnplug(port, cable, operation) {
      showDialog("Plan to unplug cable");
      const other = cable.a === port.id ? cable.b : cable.a;
      content.append(description(portDescription(port.id) + " ↔ " + portDescription(other)));
      content.append(description("Both ends become free when the plan is applied."));
      content.append(actions(addButton("Cancel", () => showPortActions(port)), addButton("Add unplug to plan", () => execute(async () => {
        const removal = operation ? {id: operation.id, action: "delete", cable_id: cable.id, before: {a: cable.a, b: cable.b}}
          : changeFromStock(cable, "delete");
        await stage(removal, "Planned unplug saved.");
      }), "danger")));
    }

    function removeChange(operation, back = showChanges) {
      showDialog("Remove planned change");
      content.append(description("Remove this " + operationName[operation.action].toLowerCase() + " from the draft?"));
      content.append(actions(addButton("Cancel", back), addButton("Remove change", () => execute(async () => {
        await save({operations: operations().filter(item => item.id !== operation.id)});
        cancel();
        back();
      }), "danger")));
    }

    function showPortActions(port = source) {
      if (!port || !editing()) return;
      showDialog("Plan port actions");
      const connection = cableAtPort(port);
      const portState = plannedPort(port.id);
      const stockCable = cables.get(port.cableId);
      const related = [...new Set([...(operationsByPort.get(port.id) ?? []), changesByCable.get(port.cableId)].filter(Boolean))];
      const status = {conflict: "Conflicting target", connected: "Connected in plan", released: "Free after apply"}[portState]
        ?? (stockCable ? "Connected in inventory" : port.blocked ? "Unavailable" : "Free in inventory");
      content.append(node("p", "fw-semibold mb-1", portDescription(port.id)), description(status));
      if (stockCable) {
        const other = stockCable.a === port.id ? stockCable.b : stockCable.a;
        content.append(description("Inventory peer: " + portDescription(other)));
      }
      if (connection?.a && connection?.b && connection.action !== "stock") {
        const other = connection.a === port.id ? connection.b : connection.a;
        content.append(description("Planned peer: " + portDescription(other)));
      }
      const buttons = [];
      if (canDrag(port)) buttons.push(addButton(connection?.a ? "Choose new end" : "Choose destination", () => {
        dialog.close();
        chooseSource(port);
      }, "primary"));
      if (!connection && stockCable?.editable && !changesByCable.has(stockCable.id)) {
        buttons.push(addButton("Move inventory cable end", () => {
          dialog.close();
          chooseSource(port, {action: "stock", cable: stockCable, a: stockCable.a, b: stockCable.b});
        }, "primary"));
      }
      if (!connection) {
        for (const draft of operationsByPort.get(port.id) ?? []) {
          const other = draft.a === port.id ? draft.b : draft.a;
          buttons.push(addButton("Move end for " + portDescription(other), () => {
            dialog.close();
            chooseSource(port, draft);
          }));
        }
      }
      if (connection?.action === "add") buttons.push(addButton("Edit planned cable", () => showAdd(connection)));
      if (stockCable?.deletable && data.canDelete && (!changesByCable.has(stockCable.id) || connection?.action === "move")) {
        buttons.push(addButton("Plan unplug", () => confirmUnplug(port, stockCable, changesByCable.get(stockCable.id)), "outline-danger"));
      }
      for (const operation of related) {
        buttons.push(addButton("Remove " + operationName[operation.action].toLowerCase() + " from plan",
          () => removeChange(operation, () => showPortActions(port))));
      }
      content.append(actions(...buttons, addButton("Close", () => dialog.close())));
    }

    function renderChanges(items, {editable = false, recommended = new Map()} = {}) {
      const list = node("div", "list-group");
      if (!items.length) list.append(description("No cable changes in this plan."));
      for (const item of items) {
        const row = node("div", "list-group-item re-rack-plan-change-row");
        const route = node("div");
        const from = originalEnd(item, "a");
        const to = originalEnd(item, "b");
        route.append(node("span", "fw-semibold me-2", operationName[item.action] ?? item.action));
        if (item.restricted) {
          route.append(node("span", "text-muted small", "An endpoint or cable is unavailable."));
          row.append(route);
          if (editable) row.append(addButton("Remove", () => removeChange(item)));
          list.append(row);
          continue;
        }
        if (item.label) route.append(node("span", "text-muted small", item.label));
        if (item.action !== "add") route.append(node("div", "small text-muted",
          (item.action === "move" ? "Before · " : "") + portDescription(from) + " ↔ " + portDescription(to)));
        if (item.action !== "delete") route.append(node("div", "small",
          (item.action === "move" ? "After · " : "") + portDescription(item.a) + " ↔ " + portDescription(item.b)));
        row.append(route);
        const controls = node("div", "re-rack-plan-row-actions");
        if (editable && item.action === "add") {
          controls.append(addButton("Edit cable", () => showAdd(item, recommended.get(String(item.id)))));
        }
        if (editable) controls.append(addButton("Remove", () => removeChange(item)));
        const id = item.a ?? from;
        if (id && ports.has(id)) controls.append(addButton("Locate", () => { dialog.close(); locatePort(id); }));
        row.append(controls);
        list.append(row);
      }
      return list;
    }

    function showChanges() {
      showDialog("Plan changes · " + plan.name);
      content.append(renderChanges(operations(), {editable: editing()}));
    }

    const formatLength = value => value == null ? "—" : (value >= 1000
      ? new Intl.NumberFormat("en", {maximumFractionDigits: 3}).format(value / 1000) + " m"
      : new Intl.NumberFormat("en", {maximumFractionDigits: 1}).format(value) + " mm");
    const endpointLabel = endpoint => {
      if (typeof endpoint === "string") return portDescription(endpoint);
      const device = typeof endpoint?.device === "string" ? endpoint.device : endpoint?.device?.name ?? endpoint?.deviceName;
      return [device, endpoint?.name ?? endpoint?.port ?? endpoint?.portName].filter(Boolean).join(" · ") || "Unavailable";
    };
    const reportStatus = {ready: "Ready", review: "Needs review", "too-short": "Too short",
      "potentially-shorter": "Potentially shorter"};
    const finding = row => (row.warnings ?? []).join(" · ") || reportStatus[row.status] || "—";

    function reportUrl(scope, kind, download = false) {
      const endpoint = new URL(httpUrl(config.reportUrl));
      if (scope === "plan") endpoint.searchParams.set("plan", plan.id);
      if (kind === "bom") endpoint.searchParams.set("view", "bom");
      if (download) endpoint.searchParams.set("format", "csv");
      return endpoint.href;
    }

    function table(headers, rows) {
      const box = node("div", "table-responsive");
      const grid = node("table", "table table-sm table-vcenter mb-0 re-rack-plan-table");
      const header = grid.createTHead().insertRow();
      for (const label of headers) {
        const cell = node("th", "", label);
        cell.scope = "col";
        header.append(cell);
      }
      const body = grid.createTBody();
      for (const values of rows) {
        const row = body.insertRow();
        for (const value of values) {
          const cell = row.insertCell();
          if (value instanceof Node) cell.append(value);
          else cell.textContent = value ?? "—";
        }
      }
      box.append(grid);
      return box;
    }

    function reportTable(report, kind, scope) {
      const wrap = node("div", "re-rack-plan-report-content");
      const details = report.details ?? [];
      if (kind === "bom") {
        const rows = report.billOfMaterials ?? [];
        if (scope === "plan") wrap.append(description("Shopping list for new cables only. Moves reuse the inventory cable."));
        wrap.append(rows.length ? table(["Cable type", "Standard length", "Quantity"],
          rows.map(row => [row.typeLabel || row.type || "Unspecified", formatLength(row.lengthMm), row.quantity]))
          : description("No catalog lengths to list."));
        const review = report.billOfMaterialsReview ?? report.review ?? [];
        if (review.length) {
          wrap.append(node("h3", "h5 mt-3", "Needs review"),
            table(["Cable", "Minimum", "Finding"], review.map(row => [
              row.label || [endpointLabel(row.endpointA), endpointLabel(row.endpointB)].join(" → "),
              formatLength(row.minimumMm), finding(row),
            ])));
        }
        return wrap;
      }
      if (!details.length) {
        wrap.append(description("No connections in this report."));
        return wrap;
      }
      wrap.append(table(["Connection", "Route", "Minimum", "Catalog length", "Recorded / confirmed", "Review"],
        details.map(row => {
          const connection = node("div");
          connection.append(node("div", "fw-semibold", endpointLabel(row.endpointA) + " → " + endpointLabel(row.endpointB)),
            node("div", "small text-muted", [row.label, row.typeLabel || row.type].filter(Boolean).join(" · ")));
          const route = node("div", "", row.routeLabel || "—");
          if (row.pathMm != null) {
            const breakdown = node("details", "small text-muted");
            breakdown.append(node("summary", "", "Path " + formatLength(row.pathMm)));
            for (const segment of row.routeSegments ?? []) {
              breakdown.append(node("div", "", segment.label + " · " + formatLength(segment.lengthMm)));
            }
            breakdown.append(node("div", "", "Leads " + formatLength(row.connectorMm)),
              node("div", "", "Bends " + formatLength(row.bendMm)),
              node("div", "", "Reserve " + formatLength(row.reserveMm)));
            route.append(breakdown);
          }
          return [connection, route, formatLength(row.minimumMm) + (row.estimated ? " (est.)" : ""),
            formatLength(row.recommendedMm), formatLength(row.manualLengthMm ?? row.recordedMm), finding(row)];
        })));
      return wrap;
    }

    function showReport(initial = inView() ? "plan" : "stock") {
      showDialog("Cable calculator");
      const scope = selectInput([["stock", "Inventory"], ...(plan ? [["plan", plan.name]] : [])]);
      scope.value = initial;
      const kind = selectInput([["detail", "Detailed lengths"], ["bom", "Bill of materials"]]);
      const download = node("a", "btn btn-sm btn-outline-secondary", "Download CSV");
      const controls = node("div", "re-rack-plan-report-controls");
      controls.append(field("Scope", scope), field("Report", kind), download);
      const area = node("div");
      area.setAttribute("aria-live", "polite");
      content.append(controls, area);
      let sequence = 0;
      const update = async () => {
        const request = ++sequence;
        setError(errorBox);
        download.removeAttribute("href");
        area.replaceChildren(description("Calculating cable lengths…"));
        try {
          const {report} = await fetchJson(reportUrl(scope.value, kind.value));
          if (request !== sequence || !area.isConnected) return;
          area.replaceChildren(reportTable(report, kind.value, scope.value));
          download.href = reportUrl(scope.value, kind.value, true);
        } catch (error) {
          if (request !== sequence || !area.isConnected) return;
          area.replaceChildren();
          setError(errorBox, error.message);
        }
      };
      scope.addEventListener("change", update);
      kind.addEventListener("change", update);
      void update();
    }

    async function showPreview() {
      showDialog("Review and apply · " + plan.name);
      content.append(description("Checking occupancy, permissions and cable lengths…"));
      await execute(async () => {
        const {preview} = await write({action: "preview"});
        content.replaceChildren();
        const warnings = node("ul", "re-rack-plan-issues");
        for (const issue of preview.issues ?? []) {
          const text = typeof issue === "string" ? issue : issue.message;
          warnings.append(node("li", issue.severity === "error" ? "text-danger" : "text-warning", text));
        }
        if (warnings.childElementCount) content.append(warnings);
        const recommendations = new Map((preview.report?.details ?? []).map(row => [String(row.id), row.recommendedMm]));
        content.append(renderChanges(operations(), {editable: editing(), recommended: recommendations}));
        if (preview.report?.details?.length) {
          const summary = node("details", "mt-3");
          summary.append(node("summary", "fw-semibold", "Cable lengths and findings"), reportTable(preview.report, "detail", "plan"));
          content.append(summary);
        }
        const form = formWith();
        const status = selectInput([["planned", "Planned"], ["connected", "Connected"]]);
        if (operations().some(item => item.action === "add")) form.append(field("Status for new cables", status));
        const apply = submitButton("Apply wiring plan");
        apply.disabled = !preview.token;
        form.append(actions(addButton("Close", () => dialog.close()), apply));
        submitted(form, async () => {
          await write({action: "apply", token: preview.token, status: status.value});
          view.value = "stock";
          remember();
          location.reload();
        });
        content.append(form);
      });
    }

    selector.addEventListener("change", () => void load(selector.value));
    view.addEventListener("change", () => {
      if (view.value !== "stock" && !canEnter()) {
        view.value = "stock";
        notify("Apply or discard the pending live batch before changing view.", true);
        return;
      }
      cancel();
      refreshState();
      notify("");
    });
    opacity.addEventListener("input", updateOpacity);
    get("plan-manage").addEventListener("click", showManagement);
    get("plan-report").addEventListener("click", () => showReport());
    get("plan-changes").addEventListener("click", showChanges);
    get("plan-apply").addEventListener("click", () => void showPreview());
    get("plan-port-actions").addEventListener("click", () => showPortActions());
    get("plan-dialog-close").addEventListener("click", () => { if (!pending) dialog.close(); });
    dialog.addEventListener("cancel", event => { if (pending) event.preventDefault(); });
    dialog.addEventListener("close", () => {
      if (!draftCable) return;
      draftCable = null;
      refresh();
    });

    async function init() {
      try {
        const result = await fetchJson(config.url);
        plans = result.plans ?? [];
        syncPlans();
        if (plans.some(item => String(item.id) === String(preferences.id))) {
          await load(preferences.id, ["stock", "plan"].includes(preferences.view) ? preferences.view : "mixed");
        }
      } catch (error) {
        notify(error.message, true);
      }
    }

    function startPointer(event, port) {
      if (!event.isPrimary || event.button !== 0 || !canDrag(port)) return;
      pointer = {id: event.pointerId, from: port, x: event.clientX, y: event.clientY, moved: false};
    }

    function movePointer(event, findPort) {
      if (pointer?.id !== event.pointerId) return;
      if (!pointer.moved) {
        if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 5) return;
        pointer.moved = true;
        editor.setPointerCapture(event.pointerId);
        chooseSource(pointer.from);
      }
      pointer.point = {x: event.clientX, y: event.clientY};
      trackPointer(findPort);
      redraw();
    }

    function trackPointer(findPort) {
      const point = pointer?.point;
      if (!point) return;
      const candidate = findPort(point.x, point.y);
      const nextTarget = canTarget(candidate) ? candidate : null;
      if (target !== nextTarget) {
        target = nextTarget;
        markPorts();
      }
    }

    function endPointer(event, findPort) {
      if (pointer?.id !== event.pointerId) return false;
      const moved = pointer.moved;
      pointer = null;
      target = null;
      if (moved) {
        const candidate = findPort(event.clientX, event.clientY);
        if (canTarget(candidate)) useTarget(candidate);
        else notify("Drop on a supported port or choose a destination.");
        markPorts();
        refresh();
      }
      return moved;
    }

    function cancelPointer(id) {
      if (!pointer || (id !== undefined && pointer.id !== id)) return;
      const captured = pointer.id;
      if (pointer.moved) cancel();
      else pointer = null;
      if (editor.hasPointerCapture(captured)) editor.releasePointerCapture(captured);
    }

    return {
      init, inView, editing, markPorts, startPointer, movePointer, endPointer, cancelPointer, trackPointer,
      lineOperations: () => inView() ? operations().filter(item => item.action !== "delete" && !item.restricted) : [],
      portTooltip(port) {
        const state = plannedPort(port.id);
        const rows = operationsByPort.get(port.id) ?? [];
        if (state === "connected" && rows.length === 1) {
          const other = rows[0].a === port.id ? rows[0].b : rows[0].a;
          return "Plan → " + portDescription(other);
        }
        return portStatuses[state] ?? "";
      },
      activeLine: () => draftCable?.id,
      inspectLine(id) {
        const operation = operations().find(item => item.id === id);
        if (!operation) return;
        draftCable = operation;
        refresh();
        if (editing() && operation.action === "add") showAdd(operation);
        else showChanges();
      },
      isDragging: () => Boolean(pointer?.moved),
      pointerLine() {
        if (!pointer?.moved || !source) return null;
        const connection = sourceConnection ?? cableAtPort(source);
        const other = connection?.a === source.id ? connection.b : connection?.a;
        return {from: other ?? source.id, to: target?.id, point: pointer.point};
      },
      select(port) {
        if (!editing() || pending) return;
        if (source && canDrag(source) && source.id !== port.id) useTarget(port);
        else if (source?.id === port.id) { cancel(); notify(""); }
        else chooseSource(port);
      },
      context(port) {
        if (!editing() || !port) return false;
        chooseSource(port);
        showPortActions(port);
        return true;
      },
      clear() {
        if (!source && !draftCable) return false;
        draftCable = null;
        cancel();
        notify("");
        return true;
      },
    };
  };
})();

