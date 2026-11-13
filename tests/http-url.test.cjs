const assert = require("node:assert/strict");
const test = require("node:test");

globalThis.document = {baseURI: "https://netbox.example/netbox/plugins/nbcableeditor/"};
globalThis.location = new URL(document.baseURI);
require("../nbcableeditor/static/nbcableeditor/http-url.js");
const httpUrl = globalThis.NbCableEditorHttpUrl;

test("API requests and links stay on the NetBox origin", () => {
  assert.equal(httpUrl("racks/1/cables/"), "https://netbox.example/netbox/plugins/nbcableeditor/racks/1/cables/");
  assert.equal(httpUrl("//netbox.example.evil/racks/1/"), null);
  assert.equal(httpUrl("https://netbox.example:8443/racks/1/"), null);
});

test("device artwork allows external HTTP(S) storage and rejects unsafe image URLs", () => {
  const remote = "https://images.example/device.png?signature=abcd";
  assert.equal(httpUrl(remote, true), remote);
  const credentials = new URL(remote);
  credentials.username = "user";
  credentials.password = "pass";
  for (const url of ["javascript:alert(1)", "data:image/svg+xml,...", "file:///secret", credentials.href, " "]) {
    assert.equal(httpUrl(url, true), null);
  }
});
