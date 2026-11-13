const assert = require("node:assert/strict");
const test = require("node:test");

globalThis.document = {baseURI: "https://netbox.example/netbox/plugins/nbcableeditor/racks/42/"};
globalThis.location = new URL(document.baseURI);
globalThis.qrcode = require("../nbcableeditor/static/nbcableeditor/qrcode-generator.js");
require("../nbcableeditor/static/nbcableeditor/http-url.js");
require("../nbcableeditor/static/nbcableeditor/rack-export-metadata.js");
require("../nbcableeditor/static/nbcableeditor/rack-export.js");

const metadata = globalThis.NbCableEditorExportMetadata;
const rack = {
  rackLocation: "Server room A",
  rackId: 42,
  rackUrl: "/netbox/dcim/racks/42/",
  editorUrl: "/netbox/plugins/nbcableeditor/racks/42/",
};
const entries = (data, options) => metadata.entries(data, options, globalThis.NbCableEditorHttpUrl);

test("PNG accepts 15,000 pixels on the longest side and rejects larger sizes", () => {
  const {dimensions} = globalThis.NbCableEditorExport;
  assert.deepEqual(dimensions({width: 400, height: 1600}, 15000), {width: 3750, height: 15000});
  assert.deepEqual(dimensions({width: 1200, height: 600}, 15000), {width: 15000, height: 7500});
  assert.throws(() => dimensions({width: 400, height: 1600}, 15001), /15000 pixels/);
});

test("export details are opt-in and QR codes are assigned only to selected, safe URLs", () => {
  assert.deepEqual(entries(rack, {}), []);
  assert.deepEqual(entries(rack, {location: true, rackId: true, editorUrl: true, qr: true}), [
    {label: "Location", value: "Server room A", link: false, qr: false},
    {label: "Rack ID", value: "42", link: false, qr: false},
    {label: "Cable Editor URL", value: "https://netbox.example" + rack.editorUrl, link: true, qr: true},
  ]);
  assert.deepEqual(entries({...rack, rackLocation: null, rackUrl: "https://outside.example/racks/42/"}, {
    location: true, rackUrl: true, qr: true,
  }), []);
});

test("PNG measures the metadata header and draws the QR code with a four-module border", () => {
  const rectangles = [];
  const canvas = {
    measureText: text => ({width: text.length * 6}),
    save() {},
    restore() {},
    scale() {},
    fillText() {},
    fillRect(x, y, width, height) { rectangles.push({x, y, width, height, fill: this.fillStyle}); },
  };
  const ownerDocument = {createElement: () => ({getContext: () => canvas})};
  const board = {ownerDocument, getBoundingClientRect: () => ({width: 620, height: 1250})};
  const details = entries(rack, {rackUrl: true, qr: true});
  const header = metadata.imageHeader(ownerDocument, 620, details);
  const drawing = globalThis.NbCableEditorExport.measure;
  assert.deepEqual(drawing(board), {width: 620, height: 1250});
  assert.deepEqual(drawing(board, details), {width: 620, height: 1250 + header.height});
  metadata.paintHeader(canvas, header, 1, 1);
  const [, background, firstModule] = rectangles;
  assert.equal(background.fill, "#fff");
  assert.equal(firstModule.fill, "#000");
  assert.equal(firstModule.x - background.x, 4 * firstModule.width);
  assert.equal(firstModule.y - background.y, 4 * firstModule.height);
});

test("PDF prints the selected destination and its vector QR code", () => {
  function element(tag) {
    return {
      tag, attributes: {}, children: [],
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...children) { this.children.push(...children); },
    };
  }
  const doc = {createElement: element, createElementNS: (_ns, tag) => element(tag)};
  const list = metadata.printHeader(doc, entries(rack, {editorUrl: true, qr: true}));
  const [link, svg] = list.children[0].children[1].children;
  assert.equal(link.href, "https://netbox.example" + rack.editorUrl);
  assert.equal(svg.tag, "svg");
  assert.equal(svg.attributes["aria-label"], "Cable Editor URL QR code");
  assert.match(svg.children[1].attributes.d, /^M4 4h1v1h-1z/);
});
