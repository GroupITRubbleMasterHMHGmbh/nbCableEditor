(() => {
  "use strict";

  function bind(scroll, {scale, anchorAt, zoomTo, canZoom, canPan, canPanFrom, panMode, startPan, cancelCableDrag}) {
    const touches = new Map();
    let pan = null;
    let pinch = null;
    let suppressClick = false;

    const point = event => ({x: event.clientX, y: event.clientY});

    function pinchGeometry(ids) {
      const [first, second] = ids.map(id => touches.get(id));
      return {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
        distance: Math.hypot(second.x - first.x, second.y - first.y),
      };
    }

    function beginPinch() {
      const ids = [...touches.keys()].slice(0, 2);
      const center = pinchGeometry(ids);
      cancelCableDrag();
      pan = null;
      suppressClick = true;
      scroll.removeAttribute("data-panning");
      for (const id of ids) scroll.setPointerCapture(id);
      pinch = {ids, distance: Math.max(1, center.distance), scale: scale(), anchor: anchorAt(center)};
    }

    scroll.addEventListener("pointerdown", event => {
      if (!event.isPrimary && event.pointerType !== "touch") return;
      const rect = scroll.getBoundingClientRect();
      const left = rect.left + scroll.clientLeft;
      const top = rect.top + scroll.clientTop;
      if (event.clientX < left || event.clientX >= left + scroll.clientWidth ||
          event.clientY < top || event.clientY >= top + scroll.clientHeight) return;
      if (event.pointerType === "touch") {
        touches.set(event.pointerId, point(event));
        if (touches.size >= 2 && canZoom(event)) {
          if (!pinch) beginPinch();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      if (event.isPrimary && event.button === 0) suppressClick = false;
      const explicit = panMode() && event.button === 0;
      if (explicit) {
        // Capture the press before a cable, port or device link can start an action.
        suppressClick = true;
        event.preventDefault();
        event.stopPropagation();
      }
      if (pan || !canPan() || !(explicit || event.button === 1 && event.pointerType === "mouse" ||
          event.button === 0 && canPanFrom(event))) return;
      if (event.button === 1) event.preventDefault();
      pan = {id: event.pointerId, point: point(event), moved: false};
    }, {capture: true});

    window.addEventListener("pointermove", event => {
      const position = point(event);
      if (touches.has(event.pointerId)) touches.set(event.pointerId, position);
      if (pinch && touches.has(event.pointerId)) {
        const center = pinchGeometry(pinch.ids);
        zoomTo(pinch.scale * center.distance / pinch.distance, pinch.anchor, center);
      } else if (pan?.id === event.pointerId) {
        const dx = position.x - pan.point.x;
        const dy = position.y - pan.point.y;
        if (!pan.moved) {
          if (Math.hypot(dx, dy) < 4) return;
          pan.moved = suppressClick = true;
          scroll.setPointerCapture(pan.id);
          scroll.setAttribute("data-panning", "");
          startPan();
        }
        scroll.scrollLeft -= dx;
        scroll.scrollTop -= dy;
        pan.point = position;
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }, {capture: true, passive: false});

    function endPointer(event) {
      const wasTouch = touches.delete(event.pointerId);
      if (pinch && wasTouch) {
        if (pinch.ids.includes(event.pointerId)) {
          pinch = null;
          if (touches.size >= 2) beginPinch();
          else if (touches.size && event.type === "pointerup") {
            const [[id, position]] = touches;
            pan = {id, point: position, moved: true};
            scroll.setAttribute("data-panning", "");
          }
        }
        event.stopPropagation();
      } else if (pan?.id === event.pointerId) {
        if (pan.moved) event.stopPropagation();
        pan = null;
        scroll.removeAttribute("data-panning");
      }
    }

    window.addEventListener("pointerup", endPointer, {capture: true});
    window.addEventListener("pointercancel", endPointer, {capture: true});
    scroll.addEventListener("lostpointercapture", event => {
      if (event.target === scroll) endPointer(event);
    });
    window.addEventListener("blur", () => {
      touches.clear();
      pan = pinch = null;
      scroll.removeAttribute("data-panning");
    });

    for (const type of ["click", "dblclick", "auxclick"]) {
      scroll.addEventListener(type, event => {
        if (event.button !== 1 && (!event.detail || !(suppressClick || panMode()))) return;
        event.preventDefault();
        event.stopPropagation();
      }, {capture: true});
    }
    scroll.addEventListener("contextmenu", event => {
      if (!panMode()) return;
      event.preventDefault();
      event.stopPropagation();
    }, {capture: true});
    scroll.addEventListener("dragstart", event => {
      if (pan) event.preventDefault();
    });

    return {
      cancelPan() {
        const id = pan?.id;
        pan = null;
        scroll.removeAttribute("data-panning");
        if (id != null && scroll.hasPointerCapture(id)) scroll.releasePointerCapture(id);
      },
    };
  }

  globalThis.NbCableEditorViewport = {bind};
})();
