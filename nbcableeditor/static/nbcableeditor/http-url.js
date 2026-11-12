(() => {
  "use strict";

  function httpUrl(value, allowRemote = false) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, document.baseURI);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      return allowRemote || url.origin === location.origin ? url.href : null;
    } catch {
      return null;
    }
  }

  globalThis.NbCableEditorHttpUrl = httpUrl;
})();
