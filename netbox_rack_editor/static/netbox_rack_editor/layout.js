(() => {
  "use strict";

  const root = document.querySelector("#nre-layout");
  const data = JSON.parse(document.querySelector("#nre-layout-data").textContent);
  const find = (name) => root.querySelector("[data-" + name + "]");
  const stage = find("stage");
  const image = find("image");
  const placeholder = find("placeholder");
  const markerLayer = find("markers");
  const designLayer = find("design-items");
  const preview = find("preview");
  const box = find("box");
  const save = find("save");
  const status = find("status");
  const remove = find("remove");
  const newItem = find("new-item");
  const showPortNumbers = find("show-port-numbers");
  const useImage = find("use-image");
  const toolButtons = new Map(Array.from(root.querySelectorAll("[data-tool-choice]"), control =>
    [control.dataset.toolChoice, control]));
  const undo = find("undo");
  const redo = find("redo");
  const snapGrid = find("snap-grid");
  const snapObjects = find("snap-objects");
  const gridStep = find("grid-step");
  const guideX = find("snap-guide-x");
  const guideY = find("snap-guide-y");
  const alignToolbar = find("align-toolbar");
  const alignColumns = find("align-columns");
  const alignButtons = alignToolbar.querySelectorAll("[data-align]");
  const clearSelectionButton = find("clear-selection");
  const geometry = globalThis.NetBoxRackLayoutGeometry;
  const first = find("first");
  const last = find("last");
  const columns = find("columns");
  const rows = find("rows");
  const order = find("order");
  const singlePort = find("single-port");
  const place = find("place");
  const numbering = find("grid-numbering");
  const numberStart = find("number-start");
  const numberStep = find("number-step");
  const labelPrefix = find("label-prefix");
  const portLabelField = find("port-label");
  const applyPortLabel = find("apply-port-label");
  const objectText = find("object-text");
  const objectFont = find("object-font");
  const objectSize = find("object-size");
  const objectColor = find("object-color");
  const rectangleBorderColor = find("rectangle-border-color");
  const rectangleFill = find("rectangle-fill");
  const rectangleFillColor = find("rectangle-fill-color");
  const rectangleLabel = find("rectangle-label");
  const rectangleLabelPosition = find("rectangle-label-position");
  const rectangleLabelFont = find("rectangle-label-font");
  const rectangleLabelSize = find("rectangle-label-size");
  const rectangleLabelColor = find("rectangle-label-color");
  const objectBay = find("object-bay");
  const objectModuleFace = find("object-module-face");
  const placeholderSelect = find("placeholder-select");
  const placeholderInsert = find("placeholder-insert");
  const placeholderToken = find("placeholder-token");
  const rectangleStyleControls = [rectangleBorderColor, rectangleFill, rectangleFillColor];
  const rectangleLabelControls = [rectangleLabel, rectangleLabelPosition, rectangleLabelFont, rectangleLabelSize, rectangleLabelColor];
  const itemControls = [objectText, objectFont, objectSize, objectColor, objectBay, objectModuleFace,
    ...rectangleStyleControls, ...rectangleLabelControls];
  const faceButtons = root.querySelectorAll("[data-face]");
  const portById = new Map(data.ports.map((port) => [String(port.id), port]));
  const bayById = new Map((data.bays ?? []).map((bay) => [String(bay.id), bay]));
  const placements = new Map(data.placements.map((item) => [String(item.port_id), item]));
  const design = Object.fromEntries(["front", "rear"].map((name) => [name, {
    useImage: data.design?.[name]?.useImage ?? (data.layoutKind !== "module" || Boolean(data[name + "Image"])),
    items: (data.design?.[name]?.items ?? []).map((item) => ({...item})),
  }]));
  const kindNames = {interface: "Interfaces", "front-port": "Front ports", "rear-port": "Rear ports"};
  const kindPrefixes = {"front-port": "Front port", "rear-port": "Rear port"};
  const portKindOrder = Object.keys(kindNames);
  const toolHints = {
    select: "Drag to select ports, Shift-drag to add a box, or Ctrl/⌘-click to toggle a port. Drag any selected port to move the group.",
    grid: "Choose a port range, then drag a box on the drawing to space the ports evenly.",
    port: "Choose a port and click the drawing to place it.",
    text: "Enter text and click the drawing to place it. Select existing text to edit it.",
    rectangle: "Drag a box on the drawing. Hold Shift to draw over an existing item.",
    bay: "Choose the bay and drag a box where its installed module should appear.",
  };
  const faceChoices = new Map();
  const toolShortcuts = {v: "select", g: "grid", p: "port", t: "text", r: "rectangle", m: "bay"};
  const snapPreferencesKey = "netbox-rack-editor:layout-snap";
  const maxHistory = 100;
  const arrows = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  };
  const clamp = (value, max = 1) => Math.max(0, Math.min(max, value));
  const faceName = (name) => name === "front" ? "Front" : "Rear";
  const portName = (port) => port.label && port.label !== port.name
    ? port.name + " (" + port.label + ")" : port.name;
  const markerName = (port) => kindPrefixes[port.kind]
    ? kindPrefixes[port.kind] + " · " + portName(port) : portName(port);
  const compareKeys = new Intl.Collator("en", {numeric: true}).compare;
  const serialized = () => JSON.stringify({
    placements: [...placements.entries()].sort(([a], [b]) => compareKeys(a, b)).map(([, point]) => point),
    design,
  });
  const placeholderFields = data.placeholderFields ?? [];
  const samples = new Map(placeholderFields.map(({token, label, example}) => [token, example ?? label]));

  let face = "front";
  let facePorts = [];
  let activeTool = "select";
  const selectedPorts = new Set();
  let selectedItem = null;
  let gesture = null;
  let saving = false;
  let revision = data.revision;
  let saved = serialized();
  const history = [{state: saved}];
  let historyIndex = 0;
  let historyEdit = null;

  const singleSelection = () => selectedPorts.size === 1 ? selectedPorts.values().next().value : null;
  const selectedObject = () => design[face].items[selectedItem];
  const objectTool = () => selectedObject()?.kind ?? activeTool;
  const dirty = () => history[historyIndex].state !== saved;

  function recordChange(label, edit = null) {
    const state = serialized();
    if (state === history[historyIndex].state) return;
    if (edit && historyEdit === edit && historyIndex > 0) {
      if (state === history[historyIndex - 1].state) {
        history.pop();
        historyIndex--;
        historyEdit = null;
      } else {
        history[historyIndex] = {state, face, label};
      }
      return;
    }
    history.splice(historyIndex + 1);
    history.push({state, face, label});
    if (history.length > maxHistory + 1) history.shift();
    historyIndex = history.length - 1;
    historyEdit = edit;
  }

  function changeHistory(direction) {
    const next = historyIndex + direction;
    if (!data.canEdit || saving || next < 0 || next >= history.length) return;
    const action = history[Math.max(historyIndex, next)];
    const preserve = face === action.face ? [...selectedPorts] : [];
    const preserveItem = face === action.face && ["drawing item edit", "drawing item move", "drawing item position adjustment"].includes(action.label)
      ? selectedItem : null;
    const focusedPort = document.activeElement?.dataset.portId;
    endGesture();
    historyIndex = next;
    historyEdit = null;
    const snapshot = JSON.parse(history[next].state);
    placements.clear();
    for (const point of snapshot.placements) placements.set(String(point.port_id), point);
    Object.assign(design, snapshot.design);
    selectFace(action.face);
    for (const id of preserve) if (placements.get(id)?.face === face) selectedPorts.add(id);
    if (design[face].items[preserveItem]) selectedItem = preserveItem;
    refreshSelection(true);
    updateControls();
    if (focusedPort) {
      const marker = [...markerLayer.children].find(control => control.dataset.portId === focusedPort);
      (marker ?? toolButtons.get(activeTool)).focus({preventScroll: true});
    }
    showStatus((direction < 0 ? "Undid " : "Redid ") + action.label + ".");
  }

  function showStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("text-danger", isError);
  }

  function coordinates(element, point) {
    element.style.left = point.x * 100 + "%";
    element.style.top = point.y * 100 + "%";
  }

  function position(element, point) {
    coordinates(element, point);
    element.classList.toggle("nre-layout-label-below", point.y >= 0.5);
  }

  function portLabel(port, label) {
    const element = document.createElement("span");
    element.className = "nre-layout-port-label";
    element.textContent = label || port.label?.trim() || port.name.match(/\d+$/)?.[0] || port.name;
    element.classList.toggle("nre-layout-port-label-numeric", /^\d{1,3}$/.test(element.textContent));
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  function renderMarkers() {
    const markers = document.createDocumentFragment();
    for (const port of facePorts) {
      const point = placements.get(String(port.id));
      if (point?.face !== face) continue;
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "nre-layout-marker";
      marker.dataset.portId = port.id;
      marker.dataset.portKind = port.kind ?? "interface";
      marker.title = markerName(port);
      marker.setAttribute("aria-label", markerName(port));
      marker.append(portLabel(port, point.label));
      position(marker, point);
      markers.append(marker);
    }
    markerLayer.replaceChildren(markers);
    find("count").textContent = markerLayer.childElementCount + " on this face · " + placements.size +
      "/" + data.ports.length + " ports placed";
    refreshSelection();
  }

  function styleDesignText(element, item) {
    element.textContent = item.text.replace(/\{([\w.-]+)\}/g, (token, key) => samples.get(key) ?? token);
    element.style.fontFamily = item.font;
    element.style.fontSize = "calc(var(--nre-design-scale, 1) * " + item.size + "px)";
    element.style.color = item.color ?? "";
  }

  function styleRectangle(element, item) {
    element.classList.add("re-rack-rectangle-frame");
    if (item.borderColor) element.style.setProperty("--re-rack-rectangle-border", item.borderColor);
    else element.style.removeProperty("--re-rack-rectangle-border");
    element.style.backgroundColor = item.color || (item.borderColor ? "transparent" : "#43566b");
    const currentLabel = element.firstElementChild;
    if (!item.label) {
      currentLabel?.remove();
      return "Rectangle";
    }
    const label = currentLabel ?? document.createElement("span");
    label.className = "re-rack-rectangle-label";
    label.dataset.labelPosition = item.label.position;
    const text = label.firstElementChild ?? document.createElement("span");
    text.className = "re-rack-rectangle-label-text";
    styleDesignText(text, item.label);
    if (!text.parentNode) label.append(text);
    if (!currentLabel) element.append(label);
    return "Rectangle: " + text.textContent;
  }

  function styleItem(element, item) {
    coordinates(element, item);
    if (item.kind === "text") {
      styleDesignText(element, item);
      if (!element.textContent) element.textContent = "Text";
      element.setAttribute("aria-label", "Text: " + element.textContent);
    } else {
      element.style.width = item.width * 100 + "%";
      element.style.height = item.height * 100 + "%";
      if (item.kind === "rectangle") {
        element.setAttribute("aria-label", styleRectangle(element, item));
      } else {
        element.textContent = bayById.get(String(item.bay))?.name ?? "Module bay";
        element.setAttribute("aria-label", element.textContent);
      }
    }
  }

  function renderItems() {
    const items = document.createDocumentFragment();
    for (const [index, item] of design[face].items.entries()) {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "nre-layout-design-item";
      element.dataset.kind = item.kind;
      element.dataset.itemIndex = String(index);
      styleItem(element, item);
      items.append(element);
    }
    designLayer.replaceChildren(items);
    refreshSelection();
  }

  function refreshSelection(loadFields = false) {
    for (const marker of markerLayer.children) {
      marker.setAttribute("aria-pressed", String(selectedPorts.has(marker.dataset.portId)));
    }
    for (const element of designLayer.children) {
      element.setAttribute("aria-pressed", String(Number(element.dataset.itemIndex) === selectedItem));
    }
    const item = selectedObject();
    const selectedPort = singleSelection();
    find("selected").textContent = selectedPorts.size > 1 ? selectedPorts.size + " ports selected" :
      selectedPort !== null ? markerName(portById.get(selectedPort)) :
      item ? item.kind === "bay" ? "Module bay" : item.kind === "text" ? "Text" : "Rectangle" :
      "Select a port or drawing item to edit it.";
    if (remove) remove.hidden = !selectedPorts.size && selectedItem === null;
    if (newItem) newItem.hidden = selectedItem === null;
    const labelFields = find("port-label-fields");
    if (labelFields) labelFields.hidden = !data.canEdit || selectedPort === null;
    if (loadFields && portLabelField && selectedPort !== null) {
      portLabelField.value = placements.get(selectedPort).label ?? "";
    }
    if (loadFields && item) {
      if (item.kind === "text") {
        objectText.value = item.text;
        objectFont.value = item.font;
        objectSize.value = String(item.size);
        objectColor.value = item.color ?? objectColor.defaultValue;
      }
      if (item.kind === "rectangle") {
        rectangleBorderColor.value = item.borderColor ?? rectangleBorderColor.defaultValue;
        rectangleFill.checked = Boolean(item.color) || !item.borderColor;
        rectangleFillColor.value = item.color ?? rectangleFillColor.defaultValue;
        rectangleLabel.value = item.label?.text ?? "";
        rectangleLabelPosition.value = item.label?.position ?? "center";
        rectangleLabelFont.value = item.label?.font ?? "sans-serif";
        rectangleLabelSize.value = item.label?.size ?? rectangleLabelSize.defaultValue;
        rectangleLabelColor.value = item.label?.color ?? rectangleLabelColor.defaultValue;
      }
      if (item.kind === "bay") {
        objectBay.value = String(item.bay);
        if (objectModuleFace) objectModuleFace.value = item.moduleFace ?? "front";
      }
    }
  }

  function toggleSection(name, visible) {
    const section = find(name);
    if (section) section.hidden = !visible;
  }

  function renderPlaceholderOptions() {
    const groups = new Map();
    for (const {token, label, group} of placeholderFields) {
      if (!groups.has(group)) {
        const category = document.createElement("optgroup");
        category.label = group;
        groups.set(group, category);
        placeholderSelect.append(category);
      }
      groups.get(group).append(new Option(label, token));
    }
  }

  function updatePlaceholderControls(enabled, mode) {
    const available = (mode === "text" || mode === "rectangle") && placeholderFields.length > 0;
    toggleSection("placeholder-controls", available);
    placeholderSelect.disabled = !enabled || !available;
    placeholderInsert.disabled = placeholderSelect.disabled || !placeholderSelect.value;
    placeholderToken.hidden = !placeholderSelect.value;
    placeholderToken.textContent = placeholderSelect.value ? "{" + placeholderSelect.value + "}" : "";
  }

  function insertPlaceholder() {
    if (placeholderInsert.disabled) return;
    const field = objectTool() === "rectangle" ? rectangleLabel : objectText;
    const token = placeholderToken.textContent;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    if (field.value.length - (end - start) + token.length > field.maxLength) {
      showStatus("This field would exceed the " + field.maxLength + " character limit.", true);
    } else {
      showStatus("");
      field.setRangeText(token, start, end, "end");
      field.dispatchEvent(new Event("input", {bubbles: true}));
    }
    field.focus();
  }

  function updateControls() {
    const enabled = data.canEdit && !saving;
    const mode = activeTool;
    const portTool = mode === "port" || mode === "grid";
    const kind = objectTool();
    const count = selectedPorts.size;
    stage.classList.toggle("is-editable", enabled);
    stage.dataset.activeTool = mode;
    const hint = find("hint");
    if (hint) hint.textContent = toolHints[mode];
    for (const field of root.querySelectorAll("[data-tool-fields]")) {
      field.hidden = !data.canEdit || !field.dataset.toolFields.split(/\s+/).includes(mode);
    }
    toggleSection("object-fields", data.canEdit && ["text", "rectangle", "bay"].includes(kind));
    toggleSection("object-text-fields", kind === "text");
    toggleSection("object-color-field", kind === "text");
    toggleSection("rectangle-fields", kind === "rectangle");
    toggleSection("rectangle-fill-field", rectangleFill.checked);
    toggleSection("rectangle-label-fields", Boolean(rectangleLabel.value.trim()));
    toggleSection("object-bay-field", kind === "bay");
    toggleSection("empty-face", data.canEdit && portTool && !facePorts.length);
    updatePlaceholderControls(enabled, kind);
    for (const [value, control] of toolButtons) {
      const pressed = mode === value;
      control.setAttribute("aria-pressed", String(pressed));
      control.classList.toggle("active", pressed);
      control.disabled = !enabled || (value === "bay" && !bayById.size);
    }
    undo.disabled = !enabled || historyIndex === 0;
    redo.disabled = !enabled || historyIndex === history.length - 1;
    alignToolbar.hidden = !data.canEdit || count === 0;
    for (const control of [...alignButtons, alignColumns]) control.disabled = !enabled || count < 2;
    alignColumns.placeholder = "Auto (" + suggestedGridColumns() + ")";
    alignColumns.max = String(Math.max(1, count));
    clearSelectionButton.disabled = !enabled;
    for (const control of [snapGrid, snapObjects, gridStep]) control.disabled = !enabled;
    if (useImage) useImage.disabled = !enabled;
    for (const button of faceButtons) button.disabled = saving;
    for (const control of [first, last, columns, rows, order, singlePort, place, numbering]) {
      if (control) control.disabled = !enabled || !facePorts.length;
    }
    for (const control of [numberStart, numberStep, labelPrefix]) {
      if (control) control.disabled = !enabled || !facePorts.length || numbering.value !== "sequence";
    }
    for (const control of [remove, newItem, portLabelField, applyPortLabel,
      ...itemControls]) {
      if (control) control.disabled = !enabled;
    }
    if (save) save.disabled = saving || !dirty();
  }

  function background() {
    const source = (face === "front" ? data.frontImage : data.rearImage) || "";
    if (source !== (image.getAttribute("src") ?? "")) {
      image.hidden = true;
      if (source) image.src = source;
      else image.removeAttribute("src");
    }
    const ready = Boolean(source && image.complete && image.naturalWidth);
    image.hidden = !ready || !design[face].useImage;
    placeholder.hidden = !image.hidden;
    placeholder.textContent = design[face].useImage ? "No " + face.toLowerCase() + " image available" : "";
    stage.style.aspectRatio = image.hidden && ready ? image.naturalWidth + " / " + image.naturalHeight : "";
    if (useImage) useImage.checked = design[face].useImage;
  }

  function selectFace(value) {
    endGesture();
    if (facePorts.length && first) {
      faceChoices.set(face, {first: first.value, last: last.value, columns: columns.value,
        rows: rows?.value, single: singlePort?.value});
    }
    face = value;
    facePorts = data.ports.filter((port) => !port.fixedFace || port.fixedFace === face)
      .sort((a, b) => portKindOrder.indexOf(a.kind ?? "interface") - portKindOrder.indexOf(b.kind ?? "interface") ||
        compareKeys(a.name, b.name));
    selectedPorts.clear();
    selectedItem = null;
    historyEdit = null;
    for (const button of faceButtons) {
      const active = button.dataset.face === face;
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("active", active);
    }
    stage.setAttribute("aria-label", faceName(face) + " layout");
    background();
    if (first) renderPortChoices();
    renderMarkers();
    renderItems();
    updateControls();
  }

  function selectedRange() {
    return facePorts.slice(first.selectedIndex, last.selectedIndex + 1);
  }

  function renderPortChoices() {
    const groups = new Map();
    for (const port of facePorts) {
      const kind = port.kind ?? "interface";
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(port);
    }
    for (const select of [first, last, singlePort].filter(Boolean)) {
      const options = document.createDocumentFragment();
      for (const [kind, ports] of groups) {
        const parent = groups.size > 1 ? document.createElement("optgroup") : options;
        if (parent !== options) {
          parent.label = kindNames[kind];
          options.append(parent);
        }
        for (const port of ports) parent.append(new Option(portName(port), port.id));
      }
      select.replaceChildren(options);
    }
    if (!facePorts.length) return;
    const previous = faceChoices.get(face) ?? faceChoices.get(face === "front" ? "rear" : "front");
    first.value = previous?.first ?? "";
    last.value = previous?.last ?? "";
    if (singlePort && previous?.single && portById.has(previous.single)) {
      singlePort.value = previous.single;
      if (singlePort.selectedIndex < 0) singlePort.selectedIndex = 0;
    }
    const restored = first.selectedIndex >= 0 && last.selectedIndex >= 0;
    if (first.selectedIndex < 0) first.selectedIndex = 0;
    if (last.selectedIndex < 0) last.selectedIndex = facePorts.length - 1;
    columns.value = (restored ? previous?.columns : null) ?? "";
    rows.value = (restored ? previous?.rows : null) ?? "";
    updateRange(first);
  }

  function gridDimensions(count) {
    const preferredRows = rows.value ? Number(rows.value) : Math.ceil(count / 24);
    const columnCount = columns.value ? Number(columns.value) : Math.ceil(count / preferredRows);
    const rowCount = rows.value ? preferredRows : Math.ceil(count / columnCount);
    return {columnCount, rowCount};
  }

  function updateGridHints() {
    const {columnCount, rowCount} = gridDimensions(selectedRange().length);
    const hint = value => Number.isFinite(value) && value >= 1 ? "Auto (" + value + ")" : "Auto";
    columns.placeholder = hint(columnCount);
    rows.placeholder = hint(rowCount);
  }

  function updateRange(changed) {
    if (first.selectedIndex > last.selectedIndex) {
      if (changed === first) last.selectedIndex = first.selectedIndex;
      else first.selectedIndex = last.selectedIndex;
    }
    updateGridHints();
  }

  function gridCells() {
    const ports = selectedRange();
    const {columnCount, rowCount} = gridDimensions(ports.length);
    if (![columnCount, rowCount].every((value) => Number.isInteger(value) && value >= 1 && value <= 256)) {
      throw new Error("Enter 1–256 columns and rows.");
    }
    if (columnCount * rowCount < ports.length) {
      throw new Error("The grid needs at least " + ports.length + " cells for the selected ports.");
    }

    const sequence = numbering?.value === "sequence";
    const start = Number(numberStart?.value);
    const step = Number(numberStep?.value);
    if (sequence && (![start, step, start + (ports.length - 1) * step].every(Number.isSafeInteger) ||
      !numberStart.value || !numberStep.value || !step)) {
      throw new Error("Enter a starting number and a nonzero whole-number step.");
    }
    const byColumn = order.value === "columns" || order.value === "columns-reverse";
    const backwards = order.value === "rows-reverse" || order.value === "columns-reverse";
    return ports.map((port, index) => {
      const column = byColumn ? Math.floor(index / rowCount) : index % columnCount;
      const row = byColumn ? index % rowCount : Math.floor(index / columnCount);
      const label = sequence ? String(labelPrefix?.value ?? "") + (start + index * step) :
        numbering?.value === "name" ? port.name :
          numbering?.value === "reset" ? null : placements.get(String(port.id))?.label;
      return {
        port_id: port.id,
        x: columnCount === 1 ? 0.5 : (backwards ? columnCount - 1 - column : column) / (columnCount - 1),
        y: rowCount === 1 ? 0.5 : row / (rowCount - 1),
        ...(label ? {label: label.slice(0, 64)} : {}),
      };
    });
  }

  function gridIn(bounds, cells) {
    return cells.map((cell) => ({
      ...cell, face,
      x: clamp(bounds.x + bounds.width * cell.x),
      y: clamp(bounds.y + bounds.height * cell.y),
    }));
  }

  function applyGrid(bounds, cells) {
    const moved = cells.filter((cell) => {
      const previous = placements.get(String(cell.port_id));
      return previous && previous.face !== face;
    }).length;
    for (const point of gridIn(bounds, cells)) placements.set(String(point.port_id), point);
    selectedItem = null;
    selectedPorts.clear();
    for (const {port_id} of cells) selectedPorts.add(String(port_id));
    recordChange(cells.length === 1 ? "port placement" : "port grid placement");
    renderMarkers();
    refreshSelection(true);
    updateControls();
    const count = cells.length + (cells.length === 1 ? " port" : " ports");
    const detail = moved ? " (" + moved + " moved from the " + (face === "front" ? "rear" : "front") + ")" : "";
    showStatus("Placed " + count + " on the " + face + detail + ".");
  }

  function stagePoint(event, rect = stage.getBoundingClientRect()) {
    return {x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height)};
  }

  function rectangle(a, b) {
    return {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y)};
  }

  function updatePreview(bounds) {
    box.style.left = bounds.x * 100 + "%";
    box.style.top = bounds.y * 100 + "%";
    box.style.width = bounds.width * 100 + "%";
    box.style.height = bounds.height * 100 + "%";
    if (gesture.cells) {
      gridIn(bounds, gesture.cells).forEach((point, index) => position(gesture.dots[index], point));
    }
    if (gesture.mode === "select") {
      for (const marker of markerLayer.children) {
        marker.toggleAttribute("data-marquee-hit", inBounds(placements.get(marker.dataset.portId), bounds));
      }
    }
  }

  function inBounds(point, {x, y, width, height}) {
    return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
  }

  function snapStep() {
    return Math.max(2, stage.clientWidth * Number(gridStep.value) / 1000);
  }

  function updateSnapOverlay() {
    stage.toggleAttribute("data-grid-snapping", snapGrid.checked);
    stage.style.setProperty("--nre-snap-step", snapStep() + "px");
  }

  function drawGuides(x = null, y = null) {
    guideX.hidden = x === null;
    guideY.hidden = y === null;
    if (x !== null) guideX.style.left = x * 100 + "%";
    if (y !== null) guideY.style.top = y * 100 + "%";
  }

  function snapTargets(excludedPorts, excludedItem) {
    const targets = {x: [], y: []};
    for (const [id, point] of placements) {
      if (point.face !== face || excludedPorts.has(id)) continue;
      targets.x.push(point.x);
      targets.y.push(point.y);
    }
    for (const [index, item] of design[face].items.entries()) {
      if (index === excludedItem) continue;
      targets.x.push(item.x, item.x + (item.width ?? 0) / 2, item.x + (item.width ?? 0));
      targets.y.push(item.y, item.y + (item.height ?? 0) / 2, item.y + (item.height ?? 0));
    }
    return targets;
  }

  function snapped(point, event, limits, show = true) {
    const {width, height} = gesture.rect;
    const result = geometry.snapPoint(point, {
      width, height, step: snapStep(), targets: gesture.targets,
      grid: snapGrid.checked && !event.altKey, objects: snapObjects.checked && !event.altKey, ...limits,
    });
    if (show) drawGuides(result.guideX, result.guideY);
    return {x: result.x, y: result.y};
  }

  function selectionMembers() {
    return [...markerLayer.children].filter(marker => selectedPorts.has(marker.dataset.portId)).map(element =>
      ({element, point: placements.get(element.dataset.portId)}));
  }

  function movementBounds(members) {
    const points = members.map(({point}) => point);
    const x = Math.min(...points.map(point => point.x));
    const y = Math.min(...points.map(point => point.y));
    return {x, y,
      width: Math.max(...points.map(point => point.x + (point.width ?? 0))) - x,
      height: Math.max(...points.map(point => point.y + (point.height ?? 0))) - y};
  }

  function movedPoints(movement, dx, dy) {
    return movement.map(({element, point}) => ({element, point: {...point,
      x: clamp(point.x + dx, 1 - (point.width ?? 0)),
      y: clamp(point.y + dy, 1 - (point.height ?? 0)),
    }}));
  }

  function paintMovement(movement) {
    for (const {element, point} of movement) {
      if (element.dataset.portId) position(element, point);
      else coordinates(element, point);
    }
  }

  function commitMovement(movement) {
    for (const {element, point} of movement) {
      if (element.dataset.portId) placements.set(element.dataset.portId, point);
      else design[face].items[Number(element.dataset.itemIndex)] = point;
    }
    paintMovement(movement);
  }

  function selectMarker(marker, toggle = false) {
    const id = marker.dataset.portId;
    selectedItem = null;
    if (!toggle) selectedPorts.clear();
    if (selectedPorts.has(id)) selectedPorts.delete(id);
    else selectedPorts.add(id);
  }

  function readFontSize(control) {
    const size = Number(control.value);
    if (!Number.isInteger(size) || size < 8 || size > 96) throw new Error("Choose a font size from 8 to 96.");
    return size;
  }

  function readRectangle(existing, changedControl) {
    const item = existing ? {...existing} : {kind: "rectangle"};
    if (!existing || rectangleStyleControls.includes(changedControl)) {
      item.borderColor = rectangleBorderColor.value;
      if (rectangleFill.checked) item.color = rectangleFillColor.value;
      else delete item.color;
    }
    if (!existing || rectangleLabelControls.includes(changedControl)) {
      if (rectangleLabel.value.trim()) {
        item.label = {text: rectangleLabel.value, font: rectangleLabelFont.value, size: readFontSize(rectangleLabelSize),
          color: rectangleLabelColor.value, position: rectangleLabelPosition.value};
      } else delete item.label;
    }
    return item;
  }

  function readItem(kind) {
    if (kind === "text") {
      const size = readFontSize(objectSize);
      if (!objectText.value.trim()) throw new Error("Enter the text you want to place.");
      return {kind, text: objectText.value, font: objectFont.value, size, color: objectColor.value};
    }
    if (kind === "rectangle") return readRectangle();
    if (!objectBay.value) throw new Error("Choose a module bay to place.");
    return {kind: "bay", bay: Number(objectBay.value), moduleFace: objectModuleFace?.value ?? "front"};
  }

  function applyItem(item) {
    const items = design[face].items;
    if (item.kind === "bay") {
      // One position per bay on a face, even when a new rectangle replaces the old one.
      const old = items.findIndex((entry) => entry.kind === "bay" && entry.bay === item.bay);
      if (old >= 0) items.splice(old, 1);
    }
    items.push(item);
    selectedPorts.clear();
    selectedItem = items.length - 1;
    recordChange("placement of " + (item.kind === "bay" ? "a module bay" : item.kind));
    renderItems();
    refreshSelection(true);
    updateControls();
    showStatus(item.kind === "bay" ? "Placed module bay." : item.kind === "text" ? "Placed text." : "Placed rectangle.");
  }

  function beginGesture(event) {
    if (!event.isPrimary || event.button !== 0 || gesture || saving) return;
    const mode = activeTool;
    const marker = event.shiftKey ? null : event.target.closest("[data-port-id]");
    const hit = event.shiftKey ? null : event.target.closest("[data-item-index]");
    const object = hit && (!data.canEdit || mode === "select" || hit.dataset.kind === mode) ? hit : null;
    if (marker && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      selectMarker(marker, true);
      refreshSelection(true);
      updateControls();
      marker.focus({preventScroll: true});
      return;
    }
    if (marker && !selectedPorts.has(marker.dataset.portId)) selectMarker(marker);
    if (object) {
      selectedPorts.clear();
      selectedItem = Number(object.dataset.itemIndex);
    }
    if (marker || object) refreshSelection(true);
    if (!data.canEdit) {
      updateControls();
      return;
    }
    if (!marker && !object && (mode === "port" || mode === "grid") && !facePorts.length) return;
    const rect = stage.getBoundingClientRect();
    const start = stagePoint(event, rect);
    const movement = marker ? selectionMembers() : object ? [{element: object, point: selectedObject()}] : null;
    gesture = {id: event.pointerId, mode, marker, object, start, rect, movement,
      additive: event.shiftKey || event.ctrlKey || event.metaKey, clientX: event.clientX, clientY: event.clientY};
    if (movement) gesture.bounds = movementBounds(movement);
    try {
      const excludedPorts = new Set(marker ? selectedPorts : []);
      if (!movement) {
        if (mode === "grid") {
          gesture.cells = gridCells();
          for (const cell of gesture.cells) excludedPorts.add(String(cell.port_id));
          gesture.dots = gesture.cells.map(({port_id, label}) => {
            const dot = document.createElement("span");
            const port = portById.get(String(port_id));
            dot.className = "nre-layout-preview-dot";
            dot.dataset.portKind = port.kind ?? "interface";
            dot.append(portLabel(port, label));
            return dot;
          });
          preview.append(...gesture.dots);
        } else if (mode === "port") {
          excludedPorts.add(singlePort.value);
        } else if (mode !== "select") {
          gesture.item = readItem(mode);
        }
        if (["select", "grid", "rectangle", "bay"].includes(mode)) {
          box.dataset.kind = mode;
          if (mode === "rectangle") styleRectangle(box, gesture.item);
          preview.hidden = false;
        }
      }
      gesture.targets = snapObjects.checked ? snapTargets(excludedPorts, object ? selectedItem : null) : undefined;
      if (!preview.hidden) updatePreview(drawingBounds(event));
    } catch (error) {
      endGesture();
      showStatus(error.message, true);
      return;
    }
    event.preventDefault();
    (marker ?? object ?? stage).focus({preventScroll: true});
    stage.setPointerCapture(event.pointerId);
  }

  function pointerMovement(event) {
    const {bounds, movement, rect, clientX, clientY} = gesture;
    const point = {x: bounds.x + (event.clientX - clientX) / rect.width, y: bounds.y + (event.clientY - clientY) / rect.height};
    const {x, y} = snapped(point, event, {maxX: 1 - bounds.width, maxY: 1 - bounds.height,
      anchors: {x: [0, bounds.width / 2, bounds.width], y: [0, bounds.height / 2, bounds.height]}});
    return movedPoints(movement, x - bounds.x, y - bounds.y);
  }

  function drawingBounds(event) {
    const {mode, start, rect} = gesture;
    const point = stagePoint(event, rect);
    if (mode === "select") return rectangle(start, point);
    return rectangle(snapped(start, event, {}, false), snapped(point, event));
  }

  function moveGesture(event) {
    if (gesture?.id !== event.pointerId) return;
    if (gesture.movement) {
      paintMovement(pointerMovement(event));
    } else if (!preview.hidden) {
      updatePreview(drawingBounds(event));
    }
  }

  function endGesture() {
    if (!gesture) return;
    const previous = gesture;
    gesture = null;
    if (stage.hasPointerCapture(previous.id)) stage.releasePointerCapture(previous.id);
    if (previous.movement) paintMovement(previous.movement);
    if (previous.mode === "select") {
      for (const marker of markerLayer.children) marker.removeAttribute("data-marquee-hit");
    }
    drawGuides();
    preview.hidden = true;
    if (previous.item?.kind === "rectangle") {
      box.classList.remove("re-rack-rectangle-frame");
      box.style.removeProperty("--re-rack-rectangle-border");
      box.style.removeProperty("background-color");
      box.replaceChildren();
    }
    for (const dot of previous.dots ?? []) dot.remove();
  }

  function finishGesture(event) {
    if (gesture?.id !== event.pointerId) return;
    const {marker, movement, mode, cells, item, rect, additive, clientX, clientY} = gesture;
    const moved = Math.hypot(event.clientX - clientX, event.clientY - clientY) >= 4;
    const positions = movement && moved ? pointerMovement(event) : null;
    const point = !movement && (mode === "port" || mode === "text") ? snapped(stagePoint(event, rect), event) : null;
    const bounds = !movement && !point ? drawingBounds(event) : null;
    endGesture();
    if (movement) {
      if (positions) {
        commitMovement(positions);
        const label = !marker ? "drawing item move" : positions.length > 1 ? "port group move" : "port move";
        recordChange(label);
        showStatus(marker && positions.length > 1 ? "Moved " + positions.length + " ports." : "Position updated.");
      } else if (marker) {
        selectMarker(marker);
      }
      refreshSelection(true);
      updateControls();
    } else if (mode === "select") {
      selectedItem = null;
      if (!additive) selectedPorts.clear();
      if (moved) {
        for (const marker of markerLayer.children) {
          if (inBounds(placements.get(marker.dataset.portId), bounds)) selectedPorts.add(marker.dataset.portId);
        }
      }
      refreshSelection(true);
      updateControls();
    } else if (mode === "port") {
      const port = portById.get(singlePort.value);
      if (port) applyGrid({x: point.x, y: point.y, width: 0, height: 0}, [{
        port_id: port.id, x: 0.5, y: 0.5, label: placements.get(String(port.id))?.label,
      }]);
    } else if (mode === "grid" && (moved || cells.length === 1)) {
      applyGrid(bounds, cells);
    } else if (mode === "text") {
      applyItem({...item, ...point});
    } else if (item && moved && bounds.width >= 0.005 && bounds.height >= 0.005) {
      applyItem({...item, ...bounds});
    }
  }

  function removeSelectedPorts() {
    const count = selectedPorts.size;
    for (const id of selectedPorts) placements.delete(id);
    selectedPorts.clear();
    recordChange(count === 1 ? "port removal" : "port group removal");
    renderMarkers();
    updateControls();
    toolButtons.get(activeTool).focus();
    showStatus("Removed " + count + (count === 1 ? " port position." : " port positions."));
  }

  function deleteItem() {
    design[face].items.splice(selectedItem, 1);
    selectedItem = null;
    recordChange("drawing item removal");
    renderItems();
    updateControls();
    toolButtons.get(activeTool).focus();
    showStatus("Removed drawing item.");
  }

  function clearSelection() {
    endGesture();
    selectedPorts.clear();
    selectedItem = null;
    historyEdit = null;
    refreshSelection();
    updateControls();
  }

  function selectTool(mode) {
    const button = toolButtons.get(mode);
    if (!button || button.disabled || mode === activeTool) return;
    activeTool = mode;
    clearSelection();
  }

  function suggestedGridColumns() {
    if (selectedPorts.size < 2) return 1;
    const points = [...selectedPorts].map(id => placements.get(id)).sort((a, b) => a.y - b.y);
    const band = 7 / Math.max(1, stage.clientHeight);
    const rows = [];
    let start = -Infinity;
    for (const point of points) {
      if (point.y - start > band) {
        rows.push(0);
        start = point.y;
      }
      rows[rows.length - 1]++;
    }
    const widest = Math.max(...rows);
    if (widest > 1 && rows.slice(0, -1).every(count => count === widest)) return widest;
    const xs = points.map(point => point.x);
    const width = (Math.max(...xs) - Math.min(...xs)) * stage.clientWidth;
    const height = (points.at(-1).y - points[0].y) * stage.clientHeight;
    const ratio = Math.max(1, width) / Math.max(1, height);
    return Math.max(1, Math.min(points.length, Math.round(Math.sqrt(points.length * ratio))));
  }

  function alignSelection(mode) {
    if (!data.canEdit || saving || gesture || selectedPorts.size < 2) return;
    const members = selectionMembers();
    const count = members.length;
    const columns = alignColumns.value ? Number(alignColumns.value) : suggestedGridColumns();
    if (mode === "grid" && (!Number.isInteger(columns) || columns < 1 || columns > count)) {
      showStatus("Choose 1 to " + count + " columns for this selection.", true);
      alignColumns.focus();
      return;
    }
    const points = geometry.alignPorts(members.map(({point}) => point), mode, columns,
      {x: 18 / stage.clientWidth, y: 18 / stage.clientHeight});
    commitMovement(members.map(({element}, index) => ({element, point: points[index]})));
    const label = {row: "horizontal alignment", column: "vertical alignment", grid: "grid alignment"}[mode];
    recordChange(label);
    updateControls();
    showStatus("Aligned " + count + " ports" + (mode === "grid" ? " in " + columns + " columns." : "."));
  }

  function updateSelectedLabel() {
    const selectedPort = singleSelection();
    if (selectedPort === null) return;
    const point = placements.get(selectedPort);
    const label = portLabelField.value.trim().slice(0, 64);
    if (label) point.label = label;
    else delete point.label;
    recordChange("port label edit");
    renderMarkers();
    updateControls();
    showStatus("Updated port label.");
  }

  function updateSelectedItem(event) {
    if (selectedItem === null) {
      updateControls();
      return;
    }
    const item = design[face].items[selectedItem];
    try {
      const updated = item.kind === "rectangle" ? readRectangle(item, event.target) : {...item, ...readItem(item.kind)};
      if (updated.kind === "bay" && design[face].items.some((entry, index) =>
        index !== selectedItem && entry.kind === "bay" && entry.bay === updated.bay)) {
        throw new Error("This module bay already has a position on this face.");
      }
      design[face].items[selectedItem] = updated;
      recordChange("drawing item edit", event.target);
      styleItem(designLayer.children[selectedItem], updated);
      showStatus("");
    } catch (error) {
      showStatus(error.message, true);
    }
    updateControls();
  }

  function handleKeyboard(event) {
    if (!data.canEdit || saving || gesture) return;
    const marker = event.target.closest("[data-port-id]");
    const object = event.target.closest("[data-item-index]");
    if (!marker && !object) return;
    if (!Object.hasOwn(arrows, event.key) && event.key !== "Delete") return;
    event.preventDefault();
    if (marker && !selectedPorts.has(marker.dataset.portId)) selectMarker(marker);
    if (object) {
      selectedPorts.clear();
      selectedItem = Number(object.dataset.itemIndex);
    }
    if (event.key === "Delete") {
      if (marker) removeSelectedPorts();
      else deleteItem();
      return;
    }
    const [dx, dy] = arrows[event.key];
    const step = event.shiftKey ? 0.05 : 0.01;
    const members = marker ? selectionMembers() : [{element: object, point: selectedObject()}];
    const bounds = movementBounds(members);
    const x = clamp(bounds.x + dx * step, 1 - bounds.width);
    const y = clamp(bounds.y + dy * step, 1 - bounds.height);
    commitMovement(movedPoints(members, x - bounds.x, y - bounds.y));
    recordChange(marker ? "port position adjustment" : "drawing item position adjustment");
    refreshSelection(true);
    updateControls();
  }

  async function saveLayout() {
    if (saving || !dirty()) return;
    endGesture();
    historyEdit = null;
    const state = history[historyIndex].state;
    saving = true;
    updateControls();
    showStatus("Saving layout…");
    try {
      const response = await fetch(root.dataset.saveUrl, {
        method: "POST", mode: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": root.querySelector("[name=csrfmiddlewaretoken]").value,
        },
        body: JSON.stringify({...JSON.parse(state), revision}),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !Number.isSafeInteger(result.revision)) {
        throw new Error(result.error || "Unable to save the layout (HTTP " + response.status + ").");
      }
      revision = result.revision;
      saved = state;
      showStatus("Layout saved.");
    } catch (error) {
      showStatus(error.message || "Unable to save the layout.", true);
    } finally {
      saving = false;
      updateControls();
    }
  }

  stage.addEventListener("pointerdown", beginGesture);
  stage.addEventListener("pointermove", moveGesture);
  stage.addEventListener("pointerup", finishGesture);
  stage.addEventListener("keydown", handleKeyboard);
  for (const name of ["pointercancel", "lostpointercapture"]) {
    stage.addEventListener(name, (event) => {
      if (event.pointerId === gesture?.id) endGesture();
    });
  }
  stage.addEventListener("click", (event) => {
    if (event.detail) return;
    const marker = event.target.closest("[data-port-id]");
    const object = event.target.closest("[data-item-index]");
    if (!marker && !object) return;
    if (marker) selectMarker(marker, event.ctrlKey || event.metaKey);
    else {
      selectedPorts.clear();
      selectedItem = Number(object.dataset.itemIndex);
    }
    refreshSelection(true);
    updateControls();
  });
  for (const button of faceButtons) {
    button.addEventListener("click", () => {
      if (button.dataset.face !== face) selectFace(button.dataset.face);
    });
  }

  for (const event of ["load", "error"]) image.addEventListener(event, background);
  new ResizeObserver(() => {
    stage.style.setProperty("--nre-design-scale", stage.clientWidth / 1000);
    updateSnapOverlay();
  }).observe(stage);
  showPortNumbers.addEventListener("change", () =>
    stage.toggleAttribute("data-show-port-numbers", showPortNumbers.checked));
  stage.toggleAttribute("data-show-port-numbers", showPortNumbers.checked);
  if (objectBay) {
    objectBay.replaceChildren(...Array.from(bayById.values(), (bay) => new Option(bay.name, bay.id)));
  }
  for (const [mode, control] of toolButtons) control.addEventListener("click", () => selectTool(mode));
  undo.addEventListener("click", () => changeHistory(-1));
  redo.addEventListener("click", () => changeHistory(1));
  clearSelectionButton.addEventListener("click", clearSelection);
  for (const control of alignButtons) control.addEventListener("click", () => alignSelection(control.dataset.align));
  try {
    const preferences = JSON.parse(localStorage.getItem(snapPreferencesKey));
    snapGrid.checked = preferences?.grid === true;
    snapObjects.checked = preferences?.objects === true;
    if ([...gridStep.options].some(option => option.value === preferences?.step)) gridStep.value = preferences.step;
  } catch {
    // Browser storage is optional.
  }
  for (const control of [snapGrid, snapObjects, gridStep]) {
    control.addEventListener("change", () => {
      updateSnapOverlay();
      drawGuides();
      try {
        localStorage.setItem(snapPreferencesKey, JSON.stringify({grid: snapGrid.checked, objects: snapObjects.checked, step: gridStep.value}));
      } catch {
        // The current editor still uses the selected options.
      }
    });
  }
  useImage?.addEventListener("change", () => {
    design[face].useImage = useImage.checked;
    recordChange("image visibility change");
    background();
    updateControls();
  });
  for (const select of [first, last].filter(Boolean)) {
    select.addEventListener("change", () => updateRange(select));
  }
  columns?.addEventListener("input", updateGridHints);
  rows?.addEventListener("input", updateGridHints);
  numbering?.addEventListener("change", updateControls);
  place?.addEventListener("click", () => {
    try {
      applyGrid({x: 0.08, y: 0.28, width: 0.84, height: 0.44}, gridCells());
    } catch (error) {
      showStatus(error.message, true);
    }
  });
  remove?.addEventListener("click", () => {
    if (selectedItem !== null) deleteItem();
    else if (selectedPorts.size) removeSelectedPorts();
  });
  newItem?.addEventListener("click", () => {
    const mode = selectedObject()?.kind;
    if (mode !== activeTool) selectTool(mode);
    clearSelection();
    const field = {text: objectText, bay: objectBay, rectangle: rectangleLabel}[mode];
    field?.focus();
  });
  root.addEventListener("focusout", (event) => {
    if (event.target === historyEdit) historyEdit = null;
  });
  document.addEventListener("keydown", (event) => {
    if (!data.canEdit || saving || event.isComposing ||
        (!root.contains(event.target) && event.target !== document.body)) return;
    if (event.key === "Escape" && (selectedPorts.size || selectedItem !== null || gesture)) {
      event.preventDefault();
      clearSelection();
      return;
    }
    if (event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "z" || key === "y")) {
      event.preventDefault();
      changeHistory(key === "y" || event.shiftKey ? 1 : -1);
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !gesture && toolShortcuts[key]) {
      event.preventDefault();
      selectTool(toolShortcuts[key]);
    }
  });
  applyPortLabel?.addEventListener("click", updateSelectedLabel);
  portLabelField?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      updateSelectedLabel();
    }
  });
  for (const control of itemControls.filter(Boolean)) {
    control.addEventListener("input", updateSelectedItem);
  }
  renderPlaceholderOptions();
  placeholderSelect.addEventListener("change", updateControls);
  placeholderInsert.addEventListener("click", insertPlaceholder);
  if (save) {
    save.addEventListener("click", saveLayout);
    window.addEventListener("beforeunload", (event) => {
      if (!dirty()) return;
      event.preventDefault();
      event.returnValue = true;
    });
  }

  selectFace(data.ports.length && data.ports.every((port) => port.fixedFace === "rear") ? "rear" : "front");
})();
