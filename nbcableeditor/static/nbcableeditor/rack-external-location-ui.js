(() => {
  "use strict";

  const badgeClass = "re-rack-external-location-badge";
  const badgeSelector = "button[data-external-location-key]";

  function render(layer, groups, {interactive = false} = {}) {
    const existing = new Map(Array.from(layer.children, badge => [badge.dataset.externalLocationKey, badge]));
    const tag = interactive ? "BUTTON" : "SPAN";
    for (const {key, kind, name, traceKind, rect} of groups) {
      let badge = existing.get(key);
      existing.delete(key);
      if (badge?.tagName !== tag) {
        badge?.remove();
        badge = layer.ownerDocument.createElement(tag.toLowerCase());
        if (interactive) badge.type = "button";
        badge.className = badgeClass;
        badge.dataset.externalLocationKey = key;
        const label = layer.ownerDocument.createElement("span");
        label.className = "re-rack-external-location-label";
        badge.append(label);
        layer.append(badge);
      }
      badge.firstElementChild.textContent = name;
      if (traceKind) badge.dataset.traceDestination = traceKind;
      if (interactive) badge.setAttribute("aria-label", (traceKind ? "Cable trace to " : "") + kind + " " + name);
      badge.style.left = rect.left + "px";
      badge.style.top = rect.top + "px";
      badge.style.width = (rect.right - rect.left) + "px";
      badge.style.height = (rect.bottom - rect.top) + "px";
    }
    for (const badge of existing.values()) badge.remove();
  }

  function describe(document, group) {
    const fragment = document.createDocumentFragment();
    const title = document.createElement("strong");
    title.className = "re-rack-external-location-title";
    title.textContent = group.name;
    if (group.traceKind) {
      const heading = document.createElement("div");
      heading.className = "re-rack-external-location-heading";
      const kind = document.createElement("span");
      kind.className = "re-rack-external-location-kind";
      kind.textContent = group.kind;
      heading.append(kind, title);
      fragment.append(heading);
    } else {
      fragment.append(title);
    }

    const places = document.createElement("dl");
    places.className = "re-rack-external-location-places";
    for (const [field, label] of [["location", "Location"], ["rack", "Rack"], ["site", "Site"]]) {
      const names = [...new Set(group.destinations.map(destination => destination[field]?.name).filter(Boolean))];
      if (!names.length || (label === group.kind && names.length === 1 && names[0] === group.name)) continue;
      const term = document.createElement("dt");
      const value = document.createElement("dd");
      term.textContent = label;
      value.textContent = names.join(", ");
      places.append(term, value);
    }
    if (places.childElementCount) fragment.append(places);

    const devices = new Map();
    for (const {device, port} of group.destinations) {
      if (!device?.name) continue;
      const key = device.id ?? device.name;
      if (!devices.has(key)) devices.set(key, {name: device.name, ports: new Map()});
      if (port?.name) devices.get(key).ports.set(port.id ?? port.name, port.name);
    }
    if (devices.size) {
      const endpoints = document.createElement("ul");
      endpoints.className = "re-rack-external-location-devices";
      for (const {name, ports} of devices.values()) {
        const endpoint = document.createElement("li");
        const deviceName = document.createElement("strong");
        deviceName.textContent = name;
        endpoint.append(deviceName);
        if (ports.size) endpoint.append(" · " + [...ports.values()].join(", "));
        endpoints.append(endpoint);
      }
      fragment.append(endpoints);
    }
    return fragment;
  }

  function position(tooltip, badge, viewport, side) {
    const document = tooltip.ownerDocument;
    const gutter = 8;
    const bounds = badge.getBoundingClientRect();
    const {width, height} = tooltip.getBoundingClientRect();
    const start = (viewport?.offsetLeft ?? 0) + gutter;
    const end = start + (viewport?.width ?? document.documentElement.clientWidth) - 2 * gutter;
    const top = (viewport?.offsetTop ?? 0) + gutter;
    const bottom = top + (viewport?.height ?? document.documentElement.clientHeight) - 2 * gutter;
    const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
    const left = bounds.left - gutter - width;
    const right = bounds.right + gutter;
    const sides = side === "left" ? [left, right] : [right, left];
    let x = sides.find(position => position >= start && position + width <= end);
    let y = bounds.top + (bounds.height - height) / 2;
    if (x === undefined) {
      x = bounds.left + (bounds.width - width) / 2;
      y = bounds.bottom + gutter;
      if (y + height > bottom) y = bounds.top - gutter - height;
    }
    tooltip.style.left = clamp(x, start, end - width) + "px";
    tooltip.style.top = clamp(y, top, bottom - height) + "px";
  }

  function mount({layer, tooltip, hideWireTooltip, scroll}) {
    const document = layer.ownerDocument;
    const view = document.defaultView;
    let groups = new Map();
    let current = null;
    let leaveTimer;
    tooltip.classList.add("re-rack-external-location-tooltip");
    tooltip.id ||= "re-rack-external-location-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;

    function hide() {
      clearTimeout(leaveTimer);
      current?.removeAttribute("aria-describedby");
      current = null;
      tooltip.hidden = true;
    }

    function show(badge, dismissWireTooltip = true) {
      const group = groups.get(badge.dataset.externalLocationKey);
      if (!group) return;
      if (dismissWireTooltip) {
        clearTimeout(leaveTimer);
        hideWireTooltip?.();
      }
      if (current !== badge) {
        current?.removeAttribute("aria-describedby");
        current = badge;
        badge.setAttribute("aria-describedby", tooltip.id);
      }
      tooltip.replaceChildren(describe(document, group));
      tooltip.hidden = false;
      position(tooltip, badge, view.visualViewport, group.side);
    }

    function leave(target) {
      clearTimeout(leaveTimer);
      if (!current || current.contains(target) || tooltip.contains(target) || document.activeElement === current) return;
      leaveTimer = setTimeout(hide, 150);
    }

    function onScroll() {
      if (!current || document.activeElement !== current) {
        hide();
        return;
      }
      const badge = current.getBoundingClientRect();
      const viewport = scroll.getBoundingClientRect();
      if (badge.right <= viewport.left || badge.left >= viewport.right ||
          badge.bottom <= viewport.top || badge.top >= viewport.bottom) {
        hide();
        return;
      }
      const group = groups.get(current.dataset.externalLocationKey);
      if (group) position(tooltip, current, view.visualViewport, group.side);
    }

    layer.addEventListener("pointerover", event => {
      const badge = event.target.closest(badgeSelector);
      if (badge && !badge.contains(event.relatedTarget)) show(badge);
    });
    layer.addEventListener("pointerout", event => {
      if (event.target.closest(badgeSelector) === current) leave(event.relatedTarget);
    });
    layer.addEventListener("focusin", event => {
      if (event.target.matches(badgeSelector)) show(event.target);
    });
    layer.addEventListener("focusout", event => {
      if (event.target === current && !current.matches(":hover") && !tooltip.matches(":hover")) hide();
    });
    layer.addEventListener("click", event => {
      const badge = event.target.closest(badgeSelector);
      if (badge && current !== badge) show(badge);
    });
    tooltip.addEventListener("pointerenter", () => clearTimeout(leaveTimer));
    tooltip.addEventListener("pointerleave", event => leave(event.relatedTarget));
    scroll.addEventListener("scroll", onScroll, {passive: true});
    view.addEventListener("scroll", onScroll, {passive: true});
    view.addEventListener("resize", hide);
    view.addEventListener("blur", hide);
    view.visualViewport?.addEventListener("scroll", onScroll, {passive: true});
    view.visualViewport?.addEventListener("resize", hide);
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !current) return;
      if (layer.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
      }
      hide();
    });

    return {
      draw(next) {
        groups = new Map(next.map(group => [group.key, group]));
        render(layer, next, {interactive: true});
        if (current?.parentElement === layer) show(current, false);
        else hide();
      },
      hide,
    };
  }

  globalThis.NbCableEditorExternalLocationUi = {mount, render};
})();
