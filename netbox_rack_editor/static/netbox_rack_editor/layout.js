(() => {
  "use strict";

  const root = document.querySelector("#nre-layout");
  const data = JSON.parse(document.querySelector("#nre-layout-data").textContent);
  const find = (name) => root.querySelector(`[data-${name}]`);
  const stage = find("stage");
  const showPortNumbers = find("show-port-numbers");
  const image = find("image");
  const placeholder = find("placeholder");
  const markerLayer = find("markers");
  const preview = find("preview");
  const box = find("box");
  const save = find("save");
  const remove = find("remove");
  const status = find("status");
  const controls = find("controls");
  const hint = find("hint");
  const emptyFace = find("empty-face");
  const faceButtons = root.querySelectorAll("[data-face]");
  const first = find("first");
  const last = find("last");
  const columns = find("columns");
  const order = find("order");
  const place = find("place");
  const portById = new Map(data.ports.map((port) => [String(port.id), port]));
  const placements = new Map(data.placements.map((item) => [String(item.port_id), item]));
  const kindNames = { interface: "Interfaces", "front-port": "Front ports", "rear-port": "Rear ports" };
  const kindPrefixes = { "front-port": "Front port", "rear-port": "Rear port" };
  const ranges = new Map();
  const arrows = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  };
  const clamp = (n) => Math.max(0, Math.min(1, n));
  const faceName = (value) => value === "front" ? "Front" : "Rear";
  const portName = (port) => port.label && port.label !== port.name
    ? `${port.name} (${port.label})` : port.name;
  const markerName = (port) => kindPrefixes[port.kind] ? `${kindPrefixes[port.kind]} · ${portName(port)}` : portName(port);
  function portLabel(port) {
    const label = document.createElement("span");
    label.className = "nre-layout-port-label";
    label.textContent = port.label?.trim() || port.name.match(/\d+$/)?.[0] || port.name;
    label.classList.toggle("nre-layout-port-label-numeric", /^\d{1,3}$/.test(label.textContent));
    label.setAttribute("aria-hidden", "true");
    return label;
  }

  const position = (element, point) => {
    element.style.left = `${point.x * 100}%`;
    element.style.top = `${point.y * 100}%`;
    element.classList.toggle("nre-layout-label-below", point.y >= 0.5);
  };
  const compareKeys = new Intl.Collator("en", {numeric: true}).compare;
  const serialize = () => JSON.stringify([...placements.entries()]
    .sort(([a], [b]) => compareKeys(a, b)).map(([, point]) => point));

  let face = "front";
  let facePorts = [];
  let selected = null;
  let gesture = null;
  let saving = false;
  let revision = data.revision;
  let saved = serialize();
  const canPlace = () => data.canEdit && facePorts.length > 0;

  function showStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("text-danger", isError);
  }

  function refreshSelection() {
    for (const marker of markerLayer.children) {
      marker.setAttribute("aria-pressed", String(marker.dataset.portId === selected));
    }
    find("selected").textContent = selected === null
      ? "Select a marker to see its port."
      : markerName(portById.get(selected));
    if (remove) {
      remove.hidden = selected === null;
      remove.disabled = saving;
    }
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
      marker.append(portLabel(port));
      position(marker, point);
      markers.append(marker);
    }
    markerLayer.replaceChildren(markers);
    find("count").textContent = `${markerLayer.childElementCount} on this face · ${placements.size}/${data.ports.length} placed`;
    refreshSelection();
  }

  function updateControls() {
    const enabled = canPlace() && !saving;
    stage.classList.toggle("is-editable", enabled);
    for (const control of [first, last, columns, order, place]) {
      if (control) control.disabled = !enabled;
    }
    for (const button of faceButtons) button.disabled = saving;
    if (save) save.disabled = saving || serialize() === saved;
    if (remove) remove.disabled = saving;
  }

  function selectFace(value) {
    endGesture();
    if (first && facePorts.length) ranges.set(face, { first: first.value, last: last.value, columns: columns.value });
    face = value;
    facePorts = data.ports.filter((port) => !port.fixedFace || port.fixedFace === face);
    selected = null;
    for (const button of faceButtons) {
      const active = button.dataset.face === face;
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("active", active);
    }
    stage.setAttribute("aria-label", `${faceName(face)} layout`);
    placeholder.textContent = `No ${faceName(face).toLowerCase()} image available`;
    const source = face === "front" ? data.frontImage : data.rearImage;
    if (source !== image.getAttribute("src")) {
      image.hidden = true;
      placeholder.hidden = false;
      if (source) image.src = source;
      else image.removeAttribute("src");
    }
    if (first) {
      controls.hidden = !facePorts.length;
      hint.hidden = !facePorts.length;
      emptyFace.hidden = Boolean(facePorts.length);
      renderRange();
    }
    renderMarkers();
    updateControls();
  }

  image.addEventListener("load", () => {
    image.hidden = false;
    placeholder.hidden = true;
  });
  image.addEventListener("error", () => {
    image.hidden = true;
    placeholder.hidden = false;
  });

  function selectedRange() {
    return facePorts.slice(first.selectedIndex, last.selectedIndex + 1);
  }

  function renderRange() {
    const groups = new Map();
    for (const port of facePorts) {
      const kind = port.kind ?? "interface";
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(port);
    }
    for (const select of [first, last]) {
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
    const previous = ranges.get(face) ?? ranges.get(face === "front" ? "rear" : "front");
    first.value = previous?.first ?? "";
    last.value = previous?.last ?? "";
    const restored = first.selectedIndex >= 0 && last.selectedIndex >= 0;
    if (first.selectedIndex < 0) first.selectedIndex = 0;
    if (last.selectedIndex < 0) last.selectedIndex = facePorts.length - 1;
    updateRange(first);
    if (restored && Number(previous.columns) >= 1 && Number(previous.columns) <= Number(columns.max)) {
      columns.value = previous.columns;
    }
  }

  function updateRange(changed) {
    if (first.selectedIndex > last.selectedIndex) {
      if (changed === first) last.selectedIndex = first.selectedIndex;
      else first.selectedIndex = last.selectedIndex;
    }
    const size = selectedRange().length;
    columns.max = String(size);
    columns.value = String(Math.ceil(size / Math.ceil(size / 24)));
  }

  function gridCells(ports) {
    const width = Number(columns.value);
    const columnCount = Number.isInteger(width) && width >= 1 ? Math.min(width, ports.length) : 1;
    const rowCount = Math.ceil(ports.length / columnCount);
    const cells = ports.map((_, index) => ({
      row: Math.floor(index / columnCount), column: index % columnCount,
    }));
    if (order.value === "columns") cells.sort((a, b) => a.column - b.column || a.row - b.row);
    return cells.map(({ row, column }, index) => ({
      port_id: ports[index].id,
      x: columnCount === 1 ? 0.5 : column / (columnCount - 1),
      y: rowCount === 1 ? 0.5 : row / (rowCount - 1),
    }));
  }

  function gridIn(bounds, cells) {
    return cells.map((cell) => ({
      port_id: cell.port_id,
      face,
      x: clamp(bounds.left + bounds.width * cell.x),
      y: clamp(bounds.top + bounds.height * cell.y),
    }));
  }

  function applyGrid(bounds, cells) {
    const moved = cells.filter((cell) => {
      const previous = placements.get(String(cell.port_id));
      return previous && previous.face !== face;
    }).length;
    for (const point of gridIn(bounds, cells)) placements.set(String(point.port_id), point);
    selected = cells.length === 1 ? String(cells[0].port_id) : null;
    renderMarkers();
    updateControls();
    const count = cells.length === 1 ? "1 port" : `${cells.length} ports`;
    const previousFace = faceName(face === "front" ? "rear" : "front").toLowerCase();
    const detail = moved ? ` (${moved} moved from the ${previousFace})` : "";
    showStatus(`Placed ${count} on the ${faceName(face).toLowerCase()}${detail}.`);
  }

  function stagePoint(event) {
    const rect = stage.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  }

  function rectangle(a, b) {
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }

  function updatePreview(bounds) {
    box.style.left = `${bounds.left * 100}%`;
    box.style.top = `${bounds.top * 100}%`;
    box.style.width = `${bounds.width * 100}%`;
    box.style.height = `${bounds.height * 100}%`;
    gridIn(bounds, gesture.cells).forEach((point, index) => position(gesture.dots[index], point));
  }

  function beginGesture(event) {
    if (!canPlace() || saving || gesture || !event.isPrimary || event.button !== 0) return;
    const marker = event.shiftKey ? null : event.target.closest("[data-port-id]");
    gesture = {
      id: event.pointerId,
      marker,
      start: stagePoint(event),
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (marker) {
      selected = marker.dataset.portId;
      refreshSelection();
      marker.focus({ preventScroll: true });
    } else {
      gesture.cells = gridCells(selectedRange());
      gesture.dots = gesture.cells.map(({port_id}) => {
        const dot = document.createElement("span");
        const port = portById.get(String(port_id));
        dot.className = "nre-layout-preview-dot";
        dot.dataset.portKind = port.kind ?? "interface";
        dot.append(portLabel(port));
        return dot;
      });
      preview.append(...gesture.dots);
      preview.hidden = false;
      updatePreview(rectangle(gesture.start, gesture.start));
    }
    event.preventDefault();
    stage.setPointerCapture(event.pointerId);
  }

  function pointForMarker(event) {
    const original = placements.get(gesture.marker.dataset.portId);
    const rect = stage.getBoundingClientRect();
    return {
      ...original,
      x: clamp(original.x + (event.clientX - gesture.clientX) / rect.width),
      y: clamp(original.y + (event.clientY - gesture.clientY) / rect.height),
    };
  }

  function moveGesture(event) {
    if (gesture?.id !== event.pointerId) return;
    if (gesture.marker) position(gesture.marker, pointForMarker(event));
    else updatePreview(rectangle(gesture.start, stagePoint(event)));
  }

  function endGesture() {
    if (!gesture) return;
    const previous = gesture;
    gesture = null;
    if (stage.hasPointerCapture(previous.id)) stage.releasePointerCapture(previous.id);
    if (previous.marker) {
      position(previous.marker, placements.get(previous.marker.dataset.portId));
    } else {
      preview.hidden = true;
      for (const dot of previous.dots) dot.remove();
    }
  }

  function finishGesture(event) {
    if (gesture?.id !== event.pointerId) return;
    const { marker, start, cells, clientX, clientY } = gesture;
    const moved = Math.hypot(event.clientX - clientX, event.clientY - clientY) >= 4;
    const point = marker && moved ? pointForMarker(event) : null;
    endGesture();
    if (point) {
      placements.set(String(point.port_id), point);
      position(marker, point);
      updateControls();
      showStatus(`Moved ${markerName(portById.get(String(point.port_id)))}.`);
    } else if (!marker && (moved || cells.length === 1)) {
      applyGrid(rectangle(start, stagePoint(event)), cells);
    }
  }

  function removePosition(id) {
    const port = portById.get(id);
    placements.delete(id);
    selected = null;
    renderMarkers();
    first.focus();
    updateControls();
    showStatus(`Removed the position of ${markerName(port)}.`);
  }

  stage.addEventListener("pointerdown", beginGesture);
  stage.addEventListener("pointermove", moveGesture);
  stage.addEventListener("pointerup", finishGesture);
  for (const name of ["pointercancel", "lostpointercapture"]) {
    stage.addEventListener(name, (event) => {
      if (event.pointerId === gesture?.id) endGesture();
    });
  }
  markerLayer.addEventListener("click", (event) => {
    const marker = event.target.closest("[data-port-id]");
    if (!marker) return;
    selected = marker.dataset.portId;
    refreshSelection();
  });
  markerLayer.addEventListener("keydown", (event) => {
    if (!canPlace() || saving || gesture || !event.target.matches("[data-port-id]")) return;
    const id = event.target.dataset.portId;
    if (event.key === "Delete") {
      event.preventDefault();
      removePosition(id);
      return;
    }
    if (!Object.hasOwn(arrows, event.key)) return;
    event.preventDefault();
    const [dx, dy] = arrows[event.key];
    const step = event.shiftKey ? 0.05 : 0.01;
    const point = placements.get(id);
    point.x = clamp(point.x + dx * step);
    point.y = clamp(point.y + dy * step);
    position(event.target, point);
    selected = id;
    refreshSelection();
    updateControls();
  });
  for (const button of faceButtons) {
    button.addEventListener("click", () => {
      if (button.dataset.face !== face) selectFace(button.dataset.face);
    });
  }

  if (first) {
    for (const select of [first, last]) {
      select.addEventListener("change", () => updateRange(select));
    }
    place.addEventListener("click", () => {
      applyGrid({ left: 0.08, top: 0.28, width: 0.84, height: 0.44 }, gridCells(selectedRange()));
    });
    remove.addEventListener("click", () => {
      if (selected !== null && !saving) removePosition(selected);
    });
  }

  if (save) {
    save.addEventListener("click", async () => {
      if (saving || serialize() === saved) return;
      endGesture();
      saving = true;
      updateControls();
      showStatus("Saving layout…");
      try {
        const response = await fetch(root.dataset.saveUrl, {
          method: "POST",
          mode: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-CSRFToken": root.querySelector("[name=csrfmiddlewaretoken]").value,
          },
          body: JSON.stringify({ placements: JSON.parse(serialize()), revision }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !Number.isSafeInteger(result.revision)) {
          throw new Error(result.error || `Unable to save the layout (HTTP ${response.status}).`);
        }
        revision = result.revision;
        saved = serialize();
        showStatus("Layout saved.");
      } catch (error) {
        showStatus(error.message || "Unable to save the layout.", true);
      } finally {
        saving = false;
        updateControls();
      }
    });
    window.addEventListener("beforeunload", (event) => {
      if (serialize() === saved) return;
      event.preventDefault();
      event.returnValue = true;
    });
  }

  const updatePortNumbers = () => stage.toggleAttribute("data-show-port-numbers", showPortNumbers.checked);
  showPortNumbers.addEventListener("change", updatePortNumbers);
  updatePortNumbers();
  selectFace(data.ports.length && data.ports.every((port) => port.fixedFace === "rear") ? "rear" : "front");
})();
