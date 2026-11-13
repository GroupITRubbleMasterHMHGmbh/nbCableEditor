const assert = require("node:assert/strict");
const {test} = require("node:test");

require("../nbcableeditor/static/nbcableeditor/rack-external-locations.js");
require("../nbcableeditor/static/nbcableeditor/rack-external-location-ui.js");
require("../nbcableeditor/static/nbcableeditor/rack-routing.js");
require("../nbcableeditor/static/nbcableeditor/rack-corridors.js");

const {layout, stub} = globalThis.NbCableEditorExternalLocations;
const {routeCables} = globalThis.NbCableEditorRouting;

const bounds = {width: 760, height: 360};
const front = {left: 72, right: 348, top: 26, bottom: 332};
const rear = {left: 414, right: 686, top: 26, bottom: 332};
const site = {id: 1, name: "Campus"};
const rack = {id: 10, name: "Remote rack"};
const plant = {id: 25, name: "Plant room"};
const workshop = {id: 31, name: "Workshop"};

function peer(id, location) {
  return {location, rack, site, device: {id, name: "Device " + id}, port: {id, name: "Ethernet1"}};
}

function cable(id, x, y, ...destinations) {
  return {
    cable: {id, externalDestinations: destinations},
    from: id,
    endpoint: {x, y, port: id, device: "source-" + id},
    face: x < bounds.width / 2 ? "front" : "rear",
  };
}

test("visible cables sharing a location converge on one badge with distinct landing points", () => {
  const direct = peer(2, plant);
  const downstream = peer(7, workshop);
  const another = peer(3, plant);
  const first = cable(1, 96, 114, direct, downstream);
  const second = cable(2, 105, 129, another, downstream);
  const {groups, targets} = layout([first, second], {bounds, faces: {front}});
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group.key, "external-location:25");
  assert.equal(group.kind, "Location");
  assert.equal(group.name, "Plant room");
  assert.equal(group.side, "left");
  assert.deepEqual(group.cables, [first.cable, second.cable]);
  assert.deepEqual(group.destinations, [direct, downstream, another]);
  assert.equal(targets.get(1).device, group.key);
  assert.equal(targets.get(2).device, group.key);
  assert.equal(targets.get(1).x, group.rect.right);
  assert.notEqual(targets.get(1).y, targets.get(2).y);
  assert.notEqual(targets.get(1).port, targets.get(2).port);

  assert.deepEqual(layout([], {bounds, faces: {front}}).groups, []);
  assert.deepEqual(layout([second], {bounds, faces: {front}}).groups[0].cables, [second.cable]);
});

test("destination badges stay outside both faces and use permitted rack and site fallbacks", () => {
  const a = cable(1, 120, 115, peer(2, null));
  const b = cable(2, 620, 125, {...peer(3, null), rack: null});
  const c = cable(3, 642, 127, {...peer(4, null), rack: null, site: null}, peer(8, workshop));
  const {groups, targets} = layout([b, c, a], {bounds, faces: {front, rear}});
  assert.deepEqual(groups.map(({kind, side}) => [kind, side]), [["Rack", "left"], ["Site", "right"]]);
  assert.ok(groups[0].rect.right < front.left);
  assert.ok(groups[1].rect.left > rear.right);
  assert.equal(targets.has(3), false);
  assert.deepEqual(layout([a], {bounds: {width: 80, height: 50}, faces: {
    front: {left: 5, right: 75, top: 2, bottom: 48},
  }}).groups, []);
});

test("trace targets keep independent routes and group only by destination kind and ID", () => {
  const direct = cable(1, 96, 114, peer(2, plant));
  const departure = cable(2, 112, 130);
  const target = peer(4, plant);
  const traced = (source, id, kind, place, destinations = [target]) => ({
    ...source, id, destination: {...place, kind}, destinations,
  });
  const candidates = [
    direct,
    traced(direct, "trace-1-location", "location", plant),
    traced(departure, "trace-2-location", "location", plant, [target, peer(5, plant)]),
    traced(direct, "trace-1-rack", "rack", rack),
    traced(departure, "trace-2-site", "site", site),
    traced(departure, "trace-2-device", "device", target.device, [{...target, rack: null}]),
  ];
  const {groups, targets} = layout(candidates, {bounds, faces: {front, rear}});
  const byKey = new Map(groups.map(group => [group.key, group]));
  assert.equal(groups.length, 5);
  assert.equal(targets.size, candidates.length);
  assert.deepEqual(byKey.get("external-location:25").routeIds, [1]);
  assert.deepEqual(byKey.get("trace-location:25").routeIds, ["trace-1-location", "trace-2-location"]);
  assert.deepEqual(byKey.get("trace-location:25").destinations.map(peer => peer.device.id), [4, 5]);
  assert.deepEqual([...byKey.values()].filter(group => group.traceKind).map(group => group.kind).sort(),
    ["Location", "Rack", "Site", "Unracked device"]);
  for (const group of groups) {
    assert.ok(group.rect.right < front.left || group.rect.left > rear.right);
    for (const id of group.routeIds) assert.equal(targets.get(id).device, group.key);
  }
  assert.notEqual(targets.get("trace-1-location").y, targets.get("trace-2-location").y);
});

test("destinations maintain one unit of clear space and line up with a nearby cable", () => {
  const unit = 40;
  const wide = {width: 1020, height: 360};
  const front = {left: 185, right: 425, top: 20, bottom: 330};
  const rear = {left: 585, right: 825, top: 20, bottom: 330};
  const entries = [cable(1, 210, 114, peer(2, plant)), cable(2, 801, 142, peer(3, workshop))];
  const obstacles = [{id: "source-1", left: 180, right: 428, top: 100, bottom: 128}];
  for (const strategy of ["balanced", "pcb"]) {
    const {groups, targets} = layout(entries, {bounds: wide, faces: {front, rear}, obstacles}, {gap: unit, strategy});
    assert.deepEqual(groups.map(group => group.side), ["left", "right"]);
    assert.equal(obstacles[0].left - groups[0].rect.right, unit);
    assert.equal(groups[1].rect.left - rear.right, unit);
    for (const {cable, endpoint} of entries) assert.equal(targets.get(cable.id).y, endpoint.y);
  }
});

test("placement prefers the shorter clear path when a nearby side is blocked by a device", () => {
  const bounds = {width: 810, height: 360};
  const front = {left: 140, right: 435, top: 20, bottom: 340};
  const rear = {left: 450, right: 670, top: 20, bottom: 340};
  const entry = cable(1, 430, 150, peer(2, plant));
  const input = {bounds, faces: {front, rear}};
  const options = {gap: 40, strategy: "pcb"};
  assert.equal(layout([entry], input, options).groups[0].side, "right");
  const obstacle = {id: "other-side-device", left: rear.left, right: rear.right, top: 60, bottom: 290};
  const {groups, targets} = layout([entry], {...input, obstacles: [obstacle]}, options);
  assert.equal(groups[0].side, "left");
  assert.equal(targets.get(1).y, 150);
});

test("dense locations remain distinct within the board", () => {
  const small = {width: 420, height: 110};
  const face = {left: 74, right: 346, top: 10, bottom: 95};
  const entries = Array.from({length: 16}, (_, index) =>
    cable(index + 1, 210, 85, peer(index, {id: index, name: "Location " + index})));
  const {groups} = layout(entries, {bounds: small, faces: {front: face}});
  assert.equal(groups.length, entries.length);
  for (const side of ["left", "right"]) {
    const column = groups.filter(group => group.side === side).map(group => group.rect);
    assert.ok(column.length);
    assert.ok(column[0].top >= 3.999);
    assert.ok(column.at(-1).bottom <= small.height - 4);
    for (let index = 1; index < column.length; index++) {
      assert.ok(column[index].top > column[index - 1].bottom);
    }
  }
});

test("badges display the destination name in interactive and static rack drawings", () => {
  const {render} = globalThis.NbCableEditorExternalLocationUi;
  const document = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(), ownerDocument: this, children: [], dataset: {}, style: {}, attributes: {},
        get firstElementChild() { return this.children[0]; },
        append(child) { this.children.push(child); child.parentElement = this; },
        remove() { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); },
        setAttribute(name, value) { this.attributes[name] = value; },
      };
    },
  };
  const layer = document.createElement("div");
  const group = {key: "external-location:25", kind: "Location", name: "Plant room",
    rect: {left: 10, top: 16, right: 130, bottom: 36}};
  render(layer, [group], {interactive: true});
  assert.equal(layer.firstElementChild.tagName, "BUTTON");
  assert.equal(layer.firstElementChild.attributes["aria-label"], "Location Plant room");
  assert.equal(layer.firstElementChild.firstElementChild.textContent, "Plant room");
  render(layer, [group]);
  assert.equal(layer.children.length, 1);
  assert.equal(layer.firstElementChild.tagName, "SPAN");
  assert.equal(layer.firstElementChild.firstElementChild.textContent, "Plant room");

  const trace = {...group, key: "trace-location:25", traceKind: "location"};
  render(layer, [group, trace], {interactive: true});
  assert.equal(layer.children[0].dataset.traceDestination, undefined);
  assert.equal(layer.children[1].dataset.traceDestination, "location");
  assert.equal(layer.children[1].attributes["aria-label"], "Cable trace to Location Plant room");
});

test("both routing strategies accept the badge as a terminal obstacle", () => {
  const entry = cable(1, 137, 124, peer(2, plant));
  const device = {id: entry.endpoint.device, left: 72, right: 348, top: 110, bottom: 148};
  const {groups, targets} = layout([entry], {bounds, faces: {front}, obstacles: [device]});
  const [group] = groups;
  const target = targets.get(1);
  const connections = [{id: 1, a: entry.endpoint, b: target}];
  for (const strategy of ["balanced", "pcb"]) {
    const routes = routeCables(connections, [device, {id: group.key, ...group.rect}], bounds, [], {strategy});
    const route = routes.get(1);
    assert.ok(route.length >= 2);
    assert.deepEqual(route.at(-1), {x: target.x, y: target.y});
  }
});

test("stub tips clear the top and bottom edges of their source device", () => {
  const device = {id: "device", left: 75, right: 250, top: 80, bottom: 160};
  const job = {bounds: {width: 330, height: 240}, obstacles: [device]};
  const top = stub({x: 160, y: 92, device: device.id, port: 1}, device, job);
  const bottom = stub({x: 160, y: 153, device: device.id, port: 2}, device, job);
  assert.equal(top.at(-1).x, 160);
  assert.ok(top.at(-1).y + 4 < device.top);
  assert.equal(bottom.at(-1).x, 160);
  assert.ok(bottom.at(-1).y - 4 > device.bottom);
});

test("stub tips avoid a neighboring card and stay inside the drawing at the rack edge", () => {
  const device = {id: "device", left: 45, right: 176, top: 54, bottom: 91};
  const neighbor = {id: "other", left: 35, right: 190, top: 8, bottom: 53};
  const job = {bounds: {width: 240, height: 124}, obstacles: [device, neighbor]};
  const origin = {x: 111, y: 61, device: device.id, port: 1};
  const tip = stub(origin, device, job).at(-1);
  assert.ok(tip.y - 4 > device.bottom);
  assert.ok(tip.y + 4 < job.bounds.height);
  assert.ok(tip.x - 4 > 0 && tip.x + 4 < job.bounds.width);

  const closeToTop = stub({x: 10, y: 4}, null, job).at(-1);
  assert.ok(closeToTop.y - 4 > 0);
});
