(() => {
  "use strict";

  const overview = document.querySelector("[data-template-overview]");
  if (!overview) return;
  const {parse} = globalThis.NbCableEditorLayoutTemplate;
  const artwork = new Map();
  const ns = "http://www.w3.org/2000/svg";
  const width = 1000;
  const height = 100;

  function template(url) {
    if (!artwork.has(url)) {
      const request = fetch(url).then(response => {
        if (!response.ok) throw new Error("Drawing unavailable");
        return response.text();
      }).then(parse).catch(error => {
        artwork.delete(url);
        throw error;
      });
      artwork.set(url, request);
    }
    return artwork.get(url);
  }

  function svgNode(name, attributes) {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }

  function caption({text, size, font, color}, x, y, anchor = "middle") {
    const node = svgNode("text", {
      x: x * width, y: y * height, fill: color ?? "currentColor", "font-size": size,
      "font-family": font, "text-anchor": anchor, "dominant-baseline": "middle",
    });
    node.textContent = text;
    return node;
  }

  function rectangleLabel(item) {
    const {position} = item.label;
    const left = position.includes("left");
    const right = position.includes("right");
    const top = position.includes("top");
    const bottom = position.includes("bottom");
    return caption(
      item.label,
      item.x + item.width * (left ? .04 : right ? .96 : .5),
      item.y + item.height * (top ? .18 : bottom ? .82 : .5),
      left ? "start" : right ? "end" : "middle",
    );
  }

  function drawFace(name, face) {
    const figure = document.createElement("figure");
    figure.className = "mb-0";
    const title = document.createElement("figcaption");
    title.className = "small text-secondary mb-1";
    const ports = face.ports.length;
    const bays = face.bays?.length ?? 0;
    title.textContent = (name === "front" ? "Front" : "Rear") + " · " +
      ports + (ports === 1 ? " port slot" : " port slots") +
      (bays ? " · " + bays + (bays === 1 ? " module bay" : " module bays") : "");
    const drawing = svgNode("svg", {viewBox: "0 0 " + width + " " + height, "aria-hidden": "true", focusable: "false"});
    for (const item of face.items) {
      if (item.kind === "text") {
        drawing.append(caption(item, item.x, item.y));
      } else {
        drawing.append(svgNode("rect", {
          x: item.x * width, y: item.y * height, width: item.width * width, height: item.height * height,
          fill: item.color ?? "none", stroke: item.borderColor ?? "#718094",
        }));
        if (item.label) drawing.append(rectangleLabel(item));
      }
    }
    for (const bay of face.bays ?? []) {
      drawing.append(svgNode("rect", {
        x: bay.x * width, y: bay.y * height, width: bay.width * width, height: bay.height * height,
        fill: "none", stroke: "#9DB8D4", "stroke-dasharray": "5 4",
      }));
      drawing.append(caption({text: bay.name, size: 9, font: "sans-serif", color: "#CBD9E7"},
        bay.x + bay.width / 2, bay.y + bay.height / 2));
    }
    for (const port of face.ports) {
      drawing.append(svgNode("circle", {cx: port.x * width, cy: port.y * height, r: 3, fill: "#88BCD7"}));
    }
    figure.append(title, drawing);
    return figure;
  }

  for (const card of overview.querySelectorAll("[data-template-device]")) {
    const preview = card.querySelector("[data-template-preview]");
    const status = preview.querySelector("[data-preview-status]");
    const faces = preview.querySelector("[data-preview-faces]");
    const choice = card.querySelector("[data-overview-template-choice]");
    const match = card.querySelector("[data-template-match]");
    const suggested = choice?.value;
    const originalMatch = match.textContent;
    let loadId = 0;

    async function show(url) {
      const id = ++loadId;
      faces.hidden = true;
      faces.replaceChildren();
      status.hidden = false;
      status.textContent = url ? "Loading drawing preview…" : "Select a template to see its drawing.";
      if (!url) return;
      try {
        const {faces: drawing} = await template(url);
        if (id !== loadId) return;
        faces.append(...["front", "rear"].filter(side => drawing[side]).map(side => drawFace(side, drawing[side])));
        faces.hidden = false;
        status.hidden = true;
      } catch {
        if (id === loadId) status.textContent = "Drawing preview unavailable. You can still review the template in the designer.";
      }
    }

    choice?.addEventListener("change", () => {
      match.textContent = choice.value === suggested ? originalMatch :
        choice.value ? "Manually selected template" : "Choose a template to review.";
      show(choice.selectedOptions[0]?.dataset.previewUrl);
    });
    show(preview.dataset.previewUrl);
  }
})();
