(() => {
  "use strict";

  const papers = {
    a5: [148, 210],
    a4: [210, 297],
    a3: [297, 420],
    a2: [420, 594],
    a1: [594, 841],
    a0: [841, 1189],
    letter: [215.9, 279.4],
    legal: [215.9, 355.6],
  };
  const margin = 10;
  let frame = null;

  function printStyles(width, height) {
    const printableWidth = width - 2 * margin;
    return `
      @page { size: ${width}mm ${height}mm; margin: ${margin}mm; }
      * { box-sizing: border-box; print-color-adjust: exact; }
      body { margin: 0; width: ${printableWidth}mm; color: #142235;
        background: #fff; font: 10pt system-ui, sans-serif; }
      .re-rack-export-cover { break-inside: avoid; }
      .re-rack-export-header h1 { margin: 0; font-size: 15pt; line-height: 1.2;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .re-rack-export-header p { margin: 1mm 0 0; color: #435267; font-size: 8pt; }
      .re-rack-export-metadata { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1.5mm 4mm; margin: 2.5mm 0 0; font-size: 8pt; }
      .re-rack-export-metadata > :only-child { grid-column: 1 / -1; }
      .re-rack-export-metadata dt { font-weight: 600; }
      .re-rack-export-metadata dd { margin: 0; color: #435267; overflow-wrap: anywhere; }
      .re-rack-export-metadata a { color: #164b82; }
      .re-rack-export-metadata svg { display: block; width: 18mm; height: 18mm; margin-top: 1mm; }
      .re-rack-export-plan { margin: 3mm 0 0; }
      .re-rack-export-plan img { display: block; height: auto; margin-inline: auto; }
      .re-rack-export-list { margin-block-start: 5mm; }
    ` + globalThis.NbCableEditorExportList.styles;
  }

  async function prepare(snapshot, {title, summary, paper, orientation, cables, metadata = []}) {
    const [short, long] = papers[paper];
    const [width, height] = orientation === "landscape" ? [long, short] : [short, long];
    frame?.remove();
    const printFrame = document.createElement("iframe");
    frame = printFrame;
    printFrame.name = "rack-export-print";
    printFrame.title = "Printable rack plan";
    printFrame.tabIndex = -1;
    printFrame.setAttribute("sandbox", "allow-same-origin allow-modals");
    printFrame.style.cssText = "position:fixed;left:-10000px;top:0;border:0;width:" +
      width + "mm;height:" + height + "mm";
    printFrame.srcdoc = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>';
    const ready = new Promise(resolve => printFrame.addEventListener("load", resolve, {once: true}));
    document.body.append(printFrame);
    try {
      await ready;
      const doc = printFrame.contentDocument;
      doc.title = title + " - Rack plan";
      const style = doc.createElement("style");
      style.textContent = printStyles(width, height);
      doc.head.append(style);

      const cover = doc.createElement("section");
      cover.className = "re-rack-export-cover";
      const header = doc.createElement("header");
      header.className = "re-rack-export-header";
      const heading = doc.createElement("h1");
      heading.textContent = title;
      const caption = doc.createElement("p");
      caption.textContent = summary;
      header.append(heading, caption);
      if (metadata.length) header.append(globalThis.NbCableEditorExportMetadata.printHeader(doc, metadata));
      const plan = doc.createElement("figure");
      plan.className = "re-rack-export-plan";
      const image = doc.createElement("img");
      image.alt = "Rack elevation and cable plan";
      image.src = globalThis.NbCableEditorExport.imageUrl(snapshot);
      plan.append(image);
      cover.append(header, plan);
      doc.body.append(cover);
      const headerHeight = header.getBoundingClientRect().height * 25.4 / 96;
      const planHeight = Math.max(1, height - 2 * margin - headerHeight - 4);
      image.style.width = Math.min(width - 2 * margin, planHeight * snapshot.width / snapshot.height) + "mm";
      if (cables) doc.body.append(globalThis.NbCableEditorExportList.render(doc, cables));
      await image.decode();
      return printFrame.contentWindow;
    } catch (error) {
      printFrame.remove();
      throw error;
    }
  }

  globalThis.NbCableEditorExportPrint = {prepare};
})();
