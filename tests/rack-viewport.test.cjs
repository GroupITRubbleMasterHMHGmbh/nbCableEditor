const assert = require("node:assert/strict");
const test = require("node:test");
require("../nbcableeditor/static/nbcableeditor/rack-viewport.js");

function target() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    emit(type, properties = {}) {
      const event = {
        type,
        isPrimary: true,
        pointerType: "mouse",
        pointerId: 1,
        button: 0,
        detail: 1,
        clientX: 40,
        clientY: 40,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
        ...properties,
      };
      listeners.get(type)?.(event);
      return event;
    },
  };
}

function fixture(options = {}) {
  globalThis.window = target();
  const captures = new Set();
  const attributes = new Set();
  const scroll = {
    ...target(),
    scrollTop: 0,
    scrollLeft: 0,
    clientWidth: 100,
    clientHeight: 100,
    clientLeft: 0,
    clientTop: 0,
    getBoundingClientRect: () => ({left: 0, top: 0}),
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    setAttribute: name => attributes.add(name),
    removeAttribute: name => attributes.delete(name),
    hasAttribute: name => attributes.has(name),
  };
  const zooms = [];
  const state = {panMode: false, canPan: true, canZoom: true, canPanFrom: false, ...options};
  const viewport = globalThis.NbCableEditorViewport.bind(scroll, {
    scale: () => 1,
    anchorAt: point => point,
    zoomTo: scale => zooms.push(scale),
    canZoom: () => state.canZoom,
    canPan: () => state.canPan,
    canPanFrom: () => state.canPanFrom,
    panMode: () => state.panMode,
    startPan: () => {},
    cancelCableDrag: () => {},
  });
  return {scroll, viewport, state, zooms, window: globalThis.window};
}

test("mouse wheel remains native scrolling, with touch pinch still zooming", () => {
  const {scroll, window, zooms} = fixture();
  assert.equal(scroll.emit("wheel", {deltaY: 120}).defaultPrevented, undefined);
  assert.deepEqual(zooms, []);

  scroll.emit("pointerdown", {pointerType: "touch", clientX: 10});
  scroll.emit("pointerdown", {pointerType: "touch", isPrimary: false, pointerId: 2, clientX: 30});
  window.emit("pointermove", {pointerType: "touch", isPrimary: false, pointerId: 2, clientX: 50});
  assert.deepEqual(zooms, [2]);
});

test("explicit pan intercepts interactive ports and keeps native scrollbar access", () => {
  const {scroll, window, state} = fixture({panMode: true});
  assert.equal(scroll.emit("pointerdown", {clientX: 101}).stopped, undefined);
  const press = scroll.emit("pointerdown");
  assert.equal(press.defaultPrevented, true);
  assert.equal(press.stopped, true);
  window.emit("pointermove", {clientY: 20});
  assert.equal(scroll.scrollTop, 20);
  assert.equal(scroll.hasAttribute("data-panning"), true);
  window.emit("pointerup");
  assert.equal(scroll.hasAttribute("data-panning"), false);
  assert.equal(scroll.emit("click").stopped, true);

  state.panMode = false;
  scroll.emit("pointerdown");
  assert.equal(scroll.emit("click").stopped, undefined);
});

test("empty area drag works without zoom and cancelling releases pointer capture", () => {
  const {scroll, window, viewport} = fixture({canZoom: false, canPanFrom: true});
  scroll.emit("pointerdown");
  window.emit("pointermove", {clientX: 20, clientY: 10});
  assert.equal(scroll.scrollLeft, 20);
  assert.equal(scroll.scrollTop, 30);
  assert.equal(scroll.hasPointerCapture(1), true);
  viewport.cancelPan();
  assert.equal(scroll.hasPointerCapture(1), false);
  assert.equal(scroll.hasAttribute("data-panning"), false);
  window.emit("pointermove", {clientY: 0});
  assert.equal(scroll.scrollTop, 30);
});

test("a locked rack suppresses clicks in pan mode without moving the viewport", () => {
  const {scroll, window} = fixture({panMode: true, canPan: false});
  assert.equal(scroll.emit("pointerdown").stopped, true);
  window.emit("pointermove", {clientY: 20});
  assert.equal(scroll.scrollTop, 0);
  assert.equal(scroll.emit("click").stopped, true);
  assert.equal(scroll.emit("contextmenu").stopped, true);
});
