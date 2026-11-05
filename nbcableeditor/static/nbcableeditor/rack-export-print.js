(() => {
  "use strict";

  const papers = {
    a5: [148, 210],
    a4: [210, 297],
    a3: [297, 420],
    letter: [215.9, 279.4],
    legal: [215.9, 355.6],
  };
  const margin = 10;
  let frame = null;

  function printStyles(width, height, aspectRatio) {
    const printableWidth = width - 2 * margin;
    // Reserve space for the heading even when the plan is tall enough to fill the sheet.
    const planWidth = Math.min(printableWidth, (height - 2 * margin - 16) * aspectRatio);
    return `
      @page { size: ${width}mm ${height}mm; margin: ${margin}mm; }
      * { box-sizing: border-box; print-color-adjust: exact; }
      body { margin: 0; width: ${printableWidth}mm; color: #142235;
        background: #fff; font: 10pt system-ui, sans-serif; }
      .re-rack-export-cover { break-inside: avoid; }
      .re-rack-export-header h1 { margin: 0; font-size: 15pt; line-height: 1.2;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .re-rack-export-header p { margin: 1mm 0 0; color: #435267; font-size: 8pt; }
      .re-rack-export-plan { margin: 3mm 0 0; }
      .re-rack-export-plan img { display: block; width: ${planWidth}mm;
        height: ${planWidth / aspectRatio}mm; margin-inline: auto; }
      .re-rack-export-list { margin-block-start: 5mm; }
    ` + globalThis.NbCableEditorExportList.styles;
  }

  async function prepare(snapshot, {title, summary, paper, orientation, cables}) {
    const [short, long] = papers[paper];
    const [width, height] = orientation === "landscape" ? [long, short] : [short, long];
    frame?.remove();
    const printFrame = document.createElement("iframe");
    frame = printFrame;
    printFrame.name = "rack-export-print";
    printFrame.title = "Printable rack plan";
    printFrame.tabIndex = -1;
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
      style.textContent = printStyles(width, height, snapshot.width / snapshot.height);
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
      const plan = doc.createElement("figure");
      plan.className = "re-rack-export-plan";
      const image = doc.createElement("img");
      image.alt = "Rack elevation and cable plan";
      image.src = globalThis.NbCableEditorExport.imageUrl(snapshot);
      plan.append(image);
      cover.append(header, plan);
      doc.body.append(cover);
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
