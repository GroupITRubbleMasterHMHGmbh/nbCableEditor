const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const test = require("node:test");

const {parse, match} = require("../nbcableeditor/static/nbcableeditor/layout-template.js");

const slot = (name, fields) => ({name, x: .2, y: .4, ...fields});
const template = () => ({
  $schema: "layout-template.schema.json",
  schemaVersion: 1,
  kind: "device",
  name: "Rack switch",
  faces: {front: {items: [], ports: [slot("eth1")]}},
});

test("accepts portable module artwork with no front face and no ports", () => {
  const value = {
    ...template(), kind: "module", modelNumber: "EX-1", sources: ["https://example.org/ex-1"],
    faces: {
      rear: {
        ports: [],
        items: [{
          kind: "rectangle", x: .2, y: .1, width: .6, height: .8, color: "#ffd100",
          label: {text: "MODULE", position: "center", font: "sans-serif", size: 16},
        }, {kind: "text", x: .5, y: .2, text: "EX-1", font: "monospace", size: 12}],
      },
    },
  };
  assert.deepEqual(parse("\uFEFF" + JSON.stringify(value)), value);
});

test("rejects device-specific IDs, image settings, and module bays", () => {
  const cases = [
    ({faces}) => { faces.front.useImage = true; },
    ({faces}) => { faces.front.ports[0].port_id = 1; },
    ({faces}) => { faces.front.items.push({kind: "bay", bay: 42, x: .2, y: .3, width: .5, height: .5}); },
  ];
  for (const mutate of cases) {
    const value = template();
    mutate(value);
    assert.throws(() => parse(JSON.stringify(value)), /unsupported field|must be text or a rectangle/);
  }
});

test("keeps template coordinates and duplicate names inside layout limits", () => {
  const value = template();
  value.faces.front.ports.push(slot(" ETH1 "));
  assert.throws(() => parse(JSON.stringify(value)), /duplicates another slot/);
  value.faces.front.ports.pop();
  value.faces.rear = {ports: [slot("ETH1")], items: []};
  assert.deepEqual(parse(JSON.stringify(value)), value);
  value.faces.front.items.push({kind: "rectangle", x: .8, y: .1, width: .3, height: .2});
  assert.throws(() => parse(JSON.stringify(value)), /fit inside the face/);
  value.faces.front.items = [];
  value.faces.front.ports[0].x = "0.2";
  assert.throws(() => parse(JSON.stringify(value)), /must be a number/);
});

test("rejects unsupported schema versions, invalid source URLs, and oversized files", () => {
  assert.throws(() => parse(JSON.stringify({...template(), schemaVersion: 2})), /supported schema version/);
  assert.throws(() => parse(JSON.stringify({...template(), sources: ["https://user:pass@example.org/"]})), /HTTPS URL/);
  assert.throws(() => parse(" ".repeat(512 * 1024 + 1)), /512 KiB/);
});

test("accepts templates without a schema hint and bounds the default port label", () => {
  const {$schema, ...value} = template();
  assert.deepEqual(parse(JSON.stringify(value)), value);
  value.faces.front.ports[0].name = "x".repeat(65);
  assert.throws(() => parse(JSON.stringify(value)), /at most 64/);
});

test("accepts portable module bay slots and rejects IDs, duplicates, or invalid geometry", () => {
  const bay = {name: "A", x: .05, y: .2, width: .4, height: .25, moduleFace: "rear"};
  const value = template();
  value.faces.front.bays = [bay];
  assert.deepEqual(parse(JSON.stringify(value)), value);
  value.faces.front.bays.push({...bay, name: " a "});
  assert.throws(() => parse(JSON.stringify(value)), /duplicates another slot/);
  value.faces.front.bays = [{...bay, bay: 1}];
  assert.throws(() => parse(JSON.stringify(value)), /unsupported field/);
  value.faces.front.bays = [{...bay, width: 1}];
  assert.throws(() => parse(JSON.stringify(value)), /fit inside the face/);
  value.faces.front.bays = [{...bay, moduleFace: "left"}];
  assert.throws(() => parse(JSON.stringify(value)), /must be front or rear/);
});

test("maps exact interface names before labels regardless of slot order", () => {
  const slots = [slot("1"), slot(" Eth1 "), slot("2", {label: "LINK"}), slot("3")];
  const ports = [
    {id: 11, name: "eth1", label: "1", kind: "interface"},
    {id: "i:12", name: "Ethernet2", label: " 2 ", kind: "interface"},
    {id: 13, name: "3", kind: "rear-port"},
    {id: 14, name: "Ethernet3", label: "3", kind: "interface"},
  ];
  assert.deepEqual(match(slots, ports), {
    assignments: new Map([[" Eth1 ", "11"], ["2", "i:12"], ["3", "14"]]),
    ambiguous: new Set(["1"]),
  });
});

test("leaves multiple candidates and guessed suffixes unresolved", () => {
  const result = match([slot("WAN"), slot("48", {label: "Ethernet48"}), slot("Eth49")], [
    {id: 1, name: "Ethernet47", label: "WAN"},
    {id: 2, name: "Ethernet48", label: "WAN"},
    {id: 3, name: "Eth49", label: "UPLINK"},
    {id: 4, name: "ETH49"},
    {id: 5, name: "unused", label: "Eth49"},
  ]);
  assert.deepEqual(result.assignments, new Map());
  assert.deepEqual(result.ambiguous, new Set(["WAN", "Eth49"]));
});

test("matches numbering patterns while retaining literal names and labels as fallbacks", () => {
  const slots = [slot("1"), slot("2"), slot("mgmt")];
  const interfaces = [{id: 10, name: "Ethernet1/1"}, {id: 11, name: "Ethernet2", label: "2"}, {id: 12, name: "mgmt"}];
  assert.deepEqual(match(slots, interfaces, "Ethernet1/{port}"), {
    assignments: new Map([["1", "10"], ["2", "11"], ["mgmt", "12"]]), ambiguous: new Set(),
  });
});

test("passive slots only match their own kind and the corresponding face", () => {
  const front = slot("1", {kind: "front-port"});
  const rear = slot("1", {kind: "rear-port"});
  const value = template();
  value.faces.front.ports = [front];
  value.faces.rear = {ports: [rear], items: []};
  assert.deepEqual(parse(JSON.stringify(value)), value);
  const targets = [
    {id: 1, name: "1", kind: "interface"},
    {id: "front-port:1", name: "P01 Front", label: "1", kind: "front-port"},
    {id: "rear-port:1", name: "1", kind: "rear-port"},
  ];
  assert.equal(match([front], targets).assignments.get("1"), "front-port:1");
  assert.equal(match([rear], targets).assignments.get("1"), "rear-port:1");
  value.faces.front.ports = [rear];
  assert.throws(() => parse(JSON.stringify(value)), /must be interface or front-port/);
});

test("built-in artwork preserves the documented ports and chassis bays", () => {
  const directory = join(__dirname, "../nbcableeditor/static/nbcableeditor/layout-templates");
  const variants = [
    ["aruba-2530-24-poe-2sfp.json", "J9779A", 28, []],
    ["aruba-2540-48g-4sfp-plus.json", "JL355A", 52, []],
    ["aruba-2920-24g.json", "J9726A", 24, ["OOBM"]],
    ["aruba-2920-48g.json", "J9728A", 48, ["OOBM"]],
    ["aruba-2930f-24g-poe-4sfp-plus.json", "JL255A", 28, []],
    ["aruba-2930f-48g-4sfp-plus.json", "JL254A", 52, []],
    ["aruba-5406r-zl2-j9821a.json", "J9821A", 0, []],
    ["aruba-5406r-zl2-j9850a.json", "J9850A", 0, []],
    ["aruba-6000-12g-poe4-2sfp.json", "R8N89A", 16, []],
    ["aruba-6100-48g-4sfp-plus.json", "JL676A", 52, []],
    ["aruba-6100-48g-poe4-4sfp-plus.json", "JL675A", 52, []],
    ["aruba-8320-48xf6q.json", "JL479A", 54, ["mgmt"]],
    ["procurve-2810-48g.json", "J9022A", 48, []],
  ];
  for (const [file, model, count, extra] of variants) {
    const asset = parse(readFileSync(join(directory, file), "utf8"));
    const names = [...Array.from({length: count}, (_, i) => String(i + 1)), ...extra];
    assert.equal(asset.modelNumber, model);
    assert.deepEqual(new Set(asset.faces.front.ports.map(port => port.name)), new Set(names));
    assert.ok(asset.faces.front.items.length && asset.faces.rear.items.length);
    assert.deepEqual(asset.faces.rear.ports, []);
    const ports = names.map((name, id) => ({id: id + 1, name, kind: "interface"}));
    const {assignments, ambiguous} = match(asset.faces.front.ports, ports);
    assert.equal(assignments.size, names.length);
    assert.equal(ambiguous.size, 0);
    if (!count) {
      const bays = [..."ABCDEF"].map((name, id) => ({id: id + 1, name}));
      assert.deepEqual(asset.faces.front.bays.map(bay => bay.name), bays.map(bay => bay.name));
      assert.equal(match(asset.faces.front.bays, bays).assignments.size, 6);
      assert.deepEqual(asset.faces.rear.bays.map(bay => [bay.name, bay.moduleFace]), [["PSU1", "rear"], ["PSU2", "rear"]]);
    }
  }
});

test("the new module and generic device assets expose the intended faces and counts", () => {
  const directory = join(__dirname, "../nbcableeditor/static/nbcableeditor/layout-templates");
  const cases = [
    ["hp-j9537a", "module", "J9537A", 24, null],
    ["hp-j9548a", "module", "J9548A", 22, null],
    ["hp-j9538a", "module", "J9538A", 8, null],
    ["aruba-j9829a", "module", "J9829A", null, 0],
    ["generic-24-port-unmanaged-switch", "device", undefined, 24, 0],
    ["generic-24-port-utp-patch-panel", "device", undefined, 24, 24],
    ["generic-lc-12-port-fiber-patch-panel", "device", undefined, 12, 12],
    ["generic-lc-24-port-fiber-patch-panel", "device", undefined, 24, 24],
    ["generic-sc-24-double-port-fiber-patch-panel", "device", undefined, 24, 24],
  ];
  for (const [file, kind, model, front, rear] of cases) {
    const asset = parse(readFileSync(join(directory, file + ".json"), "utf8"));
    assert.equal(asset.kind, kind, file);
    assert.equal(asset.modelNumber, model, file);
    for (const [side, count] of [["front", front], ["rear", rear]]) {
      const face = asset.faces[side];
      assert.equal(face?.ports.length ?? null, count, file + " " + side);
      if (!face) continue;
      assert.ok(face.items.length > 0, file);
      const portKind = rear > 0 ? side + "-port" : "interface";
      assert.deepEqual(new Set(face.ports.map(port => port.name)), new Set(Array.from({length: count}, (_, i) => String(i + 1))), file);
      assert.ok(face.ports.every(port => (port.kind ?? "interface") === portKind), file);
    }
  }
});
