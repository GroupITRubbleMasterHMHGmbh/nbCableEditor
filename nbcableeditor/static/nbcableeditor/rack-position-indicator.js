(() => {
  "use strict";

  const desktopQuery = "(hover: hover) and (pointer: fine)";
  const minimumThumbSize = 14;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function viewportGeometry(trackHeight, scrollHeight, clientHeight, scrollTop, axis) {
    const range = Math.max(0, scrollHeight - clientHeight);
    if (axis && range) {
      const offset = clamp(scrollTop, 0, range);
      const start = axis.toPhysical(offset);
      const end = axis.toPhysical(offset + clientHeight);
      const height = trackHeight * (end - start) / axis.height;
      return {height, top: trackHeight * start / axis.height, range, travel: trackHeight - height,
        progress: start / axis.toPhysical(range)};
    }
    const height = range
      ? clamp(trackHeight * clientHeight / scrollHeight, Math.min(minimumThumbSize, trackHeight), trackHeight)
      : trackHeight;
    const travel = trackHeight - height;
    const progress = range ? clamp(scrollTop / range, 0, 1) : 0;
    return {height, top: progress * travel, range, travel, progress};
  }

  function scrollForThumb({range, travel}, thumbTop) {
    return travel ? clamp(thumbTop / travel, 0, 1) * range : 0;
  }

  function positionOnAxis(axis, trackHeight, trackY) {
    return axis.toDisplayed(clamp(trackY / trackHeight, 0, 1) * axis.height);
  }

  function scrollForAxis(axis, trackHeight, clientHeight, trackY, grab) {
    const range = Math.max(0, axis.toDisplayed(axis.height) - clientHeight);
    return clamp(positionOnAxis(axis, trackHeight, trackY) - clientHeight * grab, 0, range);
  }

  function contentPosition(element, scroll, bounds) {
    const {top, left, width, height} = element.getBoundingClientRect();
    return {
      top: top - bounds.top - scroll.clientTop + scroll.scrollTop,
      left: left - bounds.left - scroll.clientLeft + scroll.scrollLeft,
      height, width,
    };
  }

  function projectRect(rect, bounds) {
    return {
      left: (rect.left - bounds.left) / bounds.width,
      top: (rect.top - bounds.top) / bounds.height,
      width: rect.width / bounds.width,
      height: rect.height / bounds.height,
    };
  }

  function physicalRect(rect, axis) {
    if (!axis) return rect;
    const top = axis.toPhysical(rect.top);
    return {...rect, top, height: axis.toPhysical(rect.top + rect.height) - top};
  }

  function horizontalViewport(trackWidth, rack, scrollLeft, clientWidth) {
    const start = clamp((scrollLeft - rack.left) / rack.width, 0, 1) * trackWidth;
    const end = clamp((scrollLeft + clientWidth - rack.left) / rack.width, 0, 1) * trackWidth;
    const width = clamp(end - start, Math.min(minimumThumbSize, trackWidth), trackWidth);
    return {left: clamp((start + end - width) / 2, 0, trackWidth - width), width};
  }

  function place(element, box) {
    for (const [property, value] of Object.entries(box)) element.style[property] = value * 100 + "%";
  }

  function detailLayers(photo, mode) {
    const layers = [];
    const imageSource = image => mode !== "hidden" && image?.naturalWidth &&
      !image.hasAttribute("data-layout-image-hidden") ? image.currentSrc || image.src : null;
    for (const element of photo.children) {
      const {left, top, width, height, backgroundColor: color} = element.style;
      if (element.tagName === "IMG") {
        const source = imageSource(element);
        if (source) layers.push({kind: "image", source});
      } else if (element.matches(".re-rack-port-marker:not([hidden])")) {
        const state = ["connected", "free"].find(value => element.classList.contains("re-rack-port-" + value));
        layers.push({kind: "port", left, top, state: state ?? "unavailable"});
      } else if (element.matches(".re-rack-artwork-bay, .re-rack-artwork-rectangle")) {
        layers.push({kind: "module", left, top, width, height, color,
          source: imageSource(element.querySelector(":scope > img"))});
      }
    }
    return layers;
  }

  function drawArtwork(mark, photo, cardRect, scroll, bounds, mode) {
    mark.artwork.hidden = !photo;
    if (!photo) return;
    place(mark.artwork, projectRect(contentPosition(photo, scroll, bounds), cardRect));
    const layers = detailLayers(photo, mode);
    const key = JSON.stringify([mode, layers]);
    if (key === mark.artworkKey) return;
    mark.artworkKey = key;
    const doc = mark.artwork.ownerDocument;
    const image = source => {
      const element = doc.createElement("img");
      element.alt = "";
      element.draggable = false;
      element.referrerPolicy = "no-referrer";
      if (mode === "faded") element.style.opacity = ".5";
      element.src = source;
      return element;
    };
    mark.artwork.replaceChildren(...layers.map(layer => {
      if (layer.kind === "image") return image(layer.source);
      const element = doc.createElement("span");
      element.className = "re-rack-position-" + layer.kind;
      Object.assign(element.style, {left: layer.left, top: layer.top});
      if (layer.kind === "port") element.dataset.positionState = layer.state;
      else {
        Object.assign(element.style, {width: layer.width, height: layer.height, backgroundColor: layer.color});
        if (layer.source) element.append(image(layer.source));
      }
      return element;
    }));
  }

  function mount({scroll, board, panel, enabled}) {
    const track = panel.querySelector("[data-position-track]");
    const faces = panel.querySelector("[data-position-faces]");
    const devices = panel.querySelector("[data-position-devices]");
    const viewport = panel.querySelector("[data-position-viewport]");
    const doc = panel.ownerDocument;
    const desktop = window.matchMedia(desktopQuery);
    const listeners = new AbortController();
    const {signal} = listeners;
    const marks = new Map();
    let frame = 0;
    let drag = null;
    let geometry = null;
    let dimensions;
    let faceKey = "";

    if (!scroll.id) scroll.id = "re-rack-scroll";
    viewport.setAttribute("aria-controls", scroll.id);
    viewport.setAttribute("aria-valuemin", "0");
    viewport.setAttribute("aria-valuemax", "100");

    function updateViewport() {
      if (panel.hidden || !dimensions) return;
      const {trackHeight, trackWidth, scrollHeight, clientHeight, rack, axis} = dimensions;
      geometry = viewportGeometry(trackHeight, scrollHeight, clientHeight, scroll.scrollTop, axis);
      const horizontal = horizontalViewport(trackWidth, rack, scroll.scrollLeft, scroll.clientWidth);
      viewport.style.top = geometry.top + "px";
      viewport.style.height = geometry.height + "px";
      viewport.style.left = horizontal.left + "px";
      viewport.style.width = horizontal.width + "px";
      const percent = Math.round(geometry.progress * 100);
      viewport.setAttribute("aria-valuenow", String(percent));
      viewport.setAttribute("aria-valuetext", percent === 0 ? "Top of rack"
        : percent === 100 ? "Bottom of rack" : percent + "% down the rack");
    }

    function jumpToCard(card) {
      if (!card.isConnected) return;
      const {top, left, height, width} = contentPosition(card, scroll, scroll.getBoundingClientRect());
      const fitsHorizontally = left >= scroll.scrollLeft && left + width <= scroll.scrollLeft + scroll.clientWidth;
      scroll.scrollTo({
        top: top + (height - scroll.clientHeight) / 2,
        left: fitsHorizontally ? scroll.scrollLeft : left + (width - scroll.clientWidth) / 2,
      });
      updateViewport();
    }

    function updateFaces(elevations, bounds) {
      const {axis, rack} = dimensions;
      const layout = elevations.map(({face, elevation, rect}) => {
        const full = physicalRect(rect, axis);
        return {
          face,
          box: projectRect(full, rack),
          rows: [...elevation.querySelectorAll(":scope > .re-rack-row")].map(row => {
            const {top, height} = projectRect(physicalRect(contentPosition(row, scroll, bounds), axis), full);
            return {top, height, count: Number(row.dataset.rackCollapsedUnits) || 1};
          }),
        };
      });
      const key = JSON.stringify(layout);
      if (key === faceKey) return;
      faceKey = key;
      faces.replaceChildren(...layout.map(({face, box, rows}) => {
        const frame = doc.createElement("div");
        frame.className = "re-rack-position-face";
        frame.dataset.positionFace = face;
        place(frame, box);
        const label = doc.createElement("span");
        label.className = "re-rack-position-face-label";
        label.textContent = face === "rear" ? "Rear" : "Front";
        frame.append(label, ...rows.map(({top, height, count}) => {
          const unit = doc.createElement("span");
          unit.className = "re-rack-position-unit";
          place(unit, {top, height});
          if (count > 1) {
            unit.dataset.positionExpandedUnits = "";
            unit.style.setProperty("--re-rack-position-unit-step", (100 / count) + "%");
          }
          return unit;
        }));
        return frame;
      }));
    }

    function updateDevices(elevations, bounds) {
      const active = new Set();
      for (const {face, elevation} of elevations) {
        for (const card of elevation.querySelectorAll(":scope > [data-rack-device]")) {
          const rect = contentPosition(card, scroll, bounds);
          if (!rect.height || !rect.width) continue;
          const key = card.dataset.rackDevice + ":" + face;
          active.add(key);
          let mark = marks.get(key);
          if (!mark) {
            const button = doc.createElement("button");
            button.type = "button";
            button.className = "re-rack-position-device";
            button.dataset.positionDevice = card.dataset.rackDevice;
            button.dataset.positionFace = face;
            const artwork = doc.createElement("span");
            artwork.className = "re-rack-position-device-artwork";
            const caption = doc.createElement("span");
            caption.className = "re-rack-position-device-label";
            caption.setAttribute("aria-hidden", "true");
            button.append(artwork, caption);
            mark = {button, artwork, caption, card};
            marks.set(key, mark);
            button.addEventListener("click", () => jumpToCard(mark.card), {signal});
            devices.append(button);
          }
          mark.card = card;
          const name = card.querySelector(".re-rack-device-name")?.textContent.trim() || "Device";
          const label = name + " · " + (face === "rear" ? "Rear" : "Front");
          mark.button.title = label;
          mark.button.setAttribute("aria-label", "Jump to " + label);
          const box = projectRect(physicalRect(rect, dimensions.axis), dimensions.rack);
          place(mark.button, box);
          mark.caption.hidden = box.height * dimensions.trackHeight < 14;
          if (mark.caption.textContent !== name) mark.caption.textContent = name;
          drawArtwork(mark, card.querySelector(":scope > .re-rack-photo"), rect, scroll, bounds, board.dataset.imageMode);
        }
      }

      for (const [key, mark] of marks) {
        if (!active.has(key)) {
          mark.button.remove();
          marks.delete(key);
        }
      }
    }

    function stopDrag() {
      if (!drag) return;
      const {id} = drag;
      drag = null;
      track.removeAttribute("data-position-dragging");
      if (track.hasPointerCapture(id)) track.releasePointerCapture(id);
    }

    function refresh() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const {clientHeight, scrollHeight} = scroll;
        panel.hidden = !enabled() || !desktop.matches || clientHeight === 0 || scrollHeight - clientHeight <= 1;
        if (panel.hidden) {
          stopDrag();
          return;
        }
        panel.toggleAttribute("data-position-both", board.dataset.rackFace === "both");
        panel.style.setProperty("--re-rack-position-scrollbar", scroll.offsetWidth - scroll.clientWidth + "px");
        const bounds = scroll.getBoundingClientRect();
        const elevations = [...board.querySelectorAll("[data-rack-face-panel]:not([hidden]) [data-elevation]")].flatMap(elevation => {
          const rect = contentPosition(elevation, scroll, bounds);
          return rect.width && rect.height ? [{face: elevation.dataset.elevation, elevation, rect}] : [];
        });
        if (!elevations.length) {
          panel.hidden = true;
          stopDrag();
          return;
        }
        const left = Math.min(...elevations.map(({rect}) => rect.left));
        const right = Math.max(...elevations.map(({rect}) => rect.left + rect.width));
        const ranges = [...elevations[0].elevation.querySelectorAll(":scope > [data-rack-collapsed-units]")].map(row => {
          const {top, height} = contentPosition(row, scroll, bounds);
          return {top, height, count: Number(row.dataset.rackCollapsedUnits)};
        });
        const axis = ranges.length ? globalThis.NbCableEditorCompactUnits.verticalAxis(ranges, scrollHeight) : null;
        const rack = {left, top: 0, width: right - left, height: axis?.height ?? scrollHeight};
        dimensions = {clientHeight, scrollHeight, trackHeight: track.clientHeight, trackWidth: track.clientWidth, rack, axis};
        updateFaces(elevations, bounds);
        updateDevices(elevations, bounds);
        updateViewport();
      });
    }

    function moveThumb(clientY, grab) {
      const y = clientY - track.getBoundingClientRect().top;
      const {axis, trackHeight, clientHeight} = dimensions;
      scroll.scrollTop = axis ? scrollForAxis(axis, trackHeight, clientHeight, y, grab)
        : scrollForThumb(geometry, y - geometry.height * grab);
      updateViewport();
    }

    track.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !event.isPrimary || drag || !geometry?.travel ||
          event.target.closest("[data-position-device]")) return;
      event.preventDefault();
      viewport.focus({preventScroll: true});
      const box = viewport.getBoundingClientRect();
      const inside = event.clientY >= box.top && event.clientY <= box.bottom &&
        event.clientX >= box.left && event.clientX <= box.right;
      let grab = 0.5;
      if (inside) {
        const {axis, trackHeight, clientHeight} = dimensions;
        const y = event.clientY - track.getBoundingClientRect().top;
        grab = axis ? clamp((positionOnAxis(axis, trackHeight, y) - scroll.scrollTop) / clientHeight, 0, 1)
          : (event.clientY - box.top) / geometry.height;
      }
      drag = {id: event.pointerId, grab};
      track.setPointerCapture(event.pointerId);
      track.setAttribute("data-position-dragging", "");
      moveThumb(event.clientY, grab);
    }, {signal});

    track.addEventListener("pointermove", event => {
      if (drag?.id === event.pointerId) moveThumb(event.clientY, drag.grab);
    }, {signal});

    for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
      track.addEventListener(eventName, event => {
        if (drag?.id === event.pointerId) stopDrag();
      }, {signal});
    }

    viewport.addEventListener("keydown", event => {
      const {scrollTop, clientHeight, scrollHeight} = scroll;
      const positions = {
        ArrowUp: scrollTop - 40, ArrowDown: scrollTop + 40,
        PageUp: scrollTop - clientHeight, PageDown: scrollTop + clientHeight,
        Home: 0, End: scrollHeight - clientHeight,
      };
      if (!Object.hasOwn(positions, event.key)) return;
      event.preventDefault();
      scroll.scrollTop = positions[event.key];
      updateViewport();
    }, {signal});

    scroll.addEventListener("scroll", updateViewport, {passive: true, signal});
    board.addEventListener("load", refresh, {capture: true, signal});
    desktop.addEventListener("change", refresh, {signal});
    const resize = new ResizeObserver(refresh);
    for (const element of [scroll, board, track]) resize.observe(element);
    const mutations = new MutationObserver(refresh);
    mutations.observe(board, {attributes: true, attributeFilter: ["data-rack-face", "data-image-mode", "data-trimmed"]});
    for (const elevation of board.querySelectorAll("[data-elevation]")) {
      mutations.observe(elevation, {subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"]});
    }
    refresh();

    return {
      refresh,
      destroy() {
        stopDrag();
        listeners.abort();
        resize.disconnect();
        mutations.disconnect();
        cancelAnimationFrame(frame);
        faces.replaceChildren();
        devices.replaceChildren();
        panel.hidden = true;
      },
    };
  }

  globalThis.NbCableEditorPositionIndicator = {
    mount, viewportGeometry, scrollForThumb, scrollForAxis, projectRect, horizontalViewport,
  };
})();
