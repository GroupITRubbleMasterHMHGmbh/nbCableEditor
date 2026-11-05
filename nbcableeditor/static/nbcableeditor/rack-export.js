(() => {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const HTML = "http://www.w3.org/1999/xhtml";
  const MAX_EDGE = 8192;
  const exportStyles = `
    .re-rack, .re-rack *, .re-rack *::before, .re-rack *::after { box-sizing: border-box; }
    .re-rack-port-marker { appearance: none; margin: 0; }
    .re-rack-device-name { text-decoration: none; }
    .re-rack-elevation-empty { margin: 0; padding: .5rem; }
  `;

  function measure(board) {
    const {width, height} = board.getBoundingClientRect();
    if (!width || !height) throw new Error("The rack drawing is empty.");
    return {width, height};
  }

  function dimensions({width, height}, longestEdge) {
    const edge = Number(longestEdge);
    if (!Number.isInteger(edge) || edge < 1 || edge > MAX_EDGE) {
      throw new Error("Choose a resolution from 1 to " + MAX_EDGE + " pixels.");
    }
    const scale = edge / Math.max(width, height);
    return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
  }

  function imageData(url) {
    if (url.startsWith("data:")) return Promise.resolve(url);
    return fetch(url).then(response => {
      if (!response.ok) throw new Error("Device image request failed.");
      return response.blob();
    }).then(blob => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    })).catch(() => {
      throw new Error("A device image could not be included in the export.");
    });
  }

  function rackStyles(document) {
    const sheets = Array.from(document.styleSheets);
    const stylesheet = name => sheets.find(({href}) =>
      href && new URL(href).pathname.endsWith("/nbcableeditor/" + name + ".css"));
    const rack = stylesheet("rack");
    if (!rack) throw new Error("The rack stylesheet is unavailable.");
    return [stylesheet("artwork"), rack].filter(Boolean)
      .flatMap(sheet => Array.from(sheet.cssRules, rule => rule.cssText)).join("\n") + exportStyles;
  }

  async function snapshot(board, decorate) {
    const document = board.ownerDocument;
    const view = document.defaultView;
    const root = document.documentElement;
    const {width, height} = measure(board);
    const css = view.getComputedStyle(board);
    const source = board.closest(".re-rack");
    const wrapper = document.createElementNS(HTML, "div");
    wrapper.className = "re-rack";
    for (const attribute of ["data-device-cable-focus", "data-interface-highlight-mode", "data-port-fill"]) {
      if (source.hasAttribute(attribute)) wrapper.setAttribute(attribute, source.getAttribute(attribute));
    }
    for (const key of Array.from(css)) {
      if (key.startsWith("--re-") || key.startsWith("--tblr-")) {
        wrapper.style.setProperty(key, css.getPropertyValue(key));
      }
    }
    wrapper.style.background = css.getPropertyValue("--re-rack-bg");
    wrapper.style.color = css.color;
    wrapper.style.fontFamily = css.fontFamily;
    wrapper.style.fontSize = css.fontSize;
    wrapper.style.lineHeight = css.lineHeight;
    wrapper.style.direction = css.direction;

    const drawing = board.cloneNode(true);
    drawing.style.width = width + "px";
    drawing.style.height = height + "px";
    // Resolve viewport-dependent routing margins and gutter before moving the drawing into the export.
    drawing.style.padding = css.padding;
    drawing.style.gridTemplateColumns = css.gridTemplateColumns;
    drawing.style.setProperty("--re-rack-board-top", css.paddingTop);
    // NetBox's base heading line-height affects every port and cable coordinate below it.
    const text = ".re-rack-face-heading, .re-rack-device-name, .re-rack-elevation-empty";
    const copiedText = drawing.querySelectorAll(text);
    board.querySelectorAll(text).forEach((element, index) => {
      const style = view.getComputedStyle(element);
      copiedText[index].style.fontWeight = style.fontWeight;
      copiedText[index].style.lineHeight = style.lineHeight;
    });
    const images = new Map();
    const copiedImages = drawing.querySelectorAll("img");
    const pending = Array.from(board.querySelectorAll("img"), (image, index) => {
      const copy = copiedImages[index];
      const url = image.currentSrc || image.src;
      copy.removeAttribute("src");
      if (!url || drawing.dataset.imageMode === "hidden" || copy.hasAttribute("data-layout-image-hidden") || !image.naturalWidth) {
        copy.remove();
        return null;
      }
      if (!images.has(url)) images.set(url, imageData(url));
      return images.get(url).then(data => copy.setAttribute("src", data));
    });
    drawing.querySelector("[data-wire-highlight]")?.parentElement.remove();
    drawing.querySelectorAll([
      "[data-rack-gap]", "[data-cable-focus-device]", ".re-rack-wire-hit", ".re-rack-wire-handle",
      ".re-rack-wire-handle-visible", "[data-wire-previews]", ".re-rack-bundle-hit",
      "[data-wire-sleeve-overlay]",
    ].join(",")).forEach(element => element.remove());
    drawing.querySelectorAll(".re-rack-wire-staged-unplug").forEach(element =>
      element.classList.remove("re-rack-wire-staged-unplug"));
    drawing.querySelectorAll(".re-rack-quick-add, .re-rack-quick-remove, .re-rack-quick-source").forEach(element => {
      element.classList.remove("re-rack-quick-add", "re-rack-quick-remove", "re-rack-quick-source");
      element.removeAttribute("aria-pressed");
    });
    drawing.querySelectorAll(".re-rack-quick-device-source, .re-rack-quick-device-target").forEach(element =>
      element.classList.remove("re-rack-quick-device-source", "re-rack-quick-device-target"));
    drawing.querySelectorAll("a[href]").forEach(element => element.removeAttribute("href"));
    drawing.querySelector("[data-wires]")?.classList.remove("re-rack-wires-hovering");
    decorate?.(drawing);
    wrapper.append(drawing);

    const svg = document.createElementNS(SVG, "svg");
    if (root.dataset.bsTheme) svg.dataset.bsTheme = root.dataset.bsTheme;
    svg.style.fontSize = view.getComputedStyle(root).fontSize;
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    const style = document.createElementNS(SVG, "style");
    style.textContent = rackStyles(document);
    const foreign = document.createElementNS(SVG, "foreignObject");
    foreign.setAttribute("width", width);
    foreign.setAttribute("height", height);
    foreign.append(wrapper);
    svg.append(style, foreign);

    await Promise.all(pending);
    return {width, height, svg: new XMLSerializer().serializeToString(svg)};
  }

  function imageUrl({svg}) {
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  async function png(snapshot, longestEdge) {
    const image = new Image();
    image.src = imageUrl(snapshot);
    await image.decode();
    const canvas = document.createElement("canvas");
    const {width, height} = dimensions(snapshot, longestEdge);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not create the export image.");
    context.drawImage(image, 0, 0, width, height);
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not encode the PNG."));
      }, "image/png");
    });
  }

  globalThis.NbCableEditorExport = {dimensions, imageUrl, measure, png, snapshot};
})();
