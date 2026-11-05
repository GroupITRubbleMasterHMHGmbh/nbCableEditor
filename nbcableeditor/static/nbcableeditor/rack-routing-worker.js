"use strict";

self.addEventListener("message", ({data}) => {
  const {connections, obstacles, bounds, protectedAreas, strategy, spacing, horizontalSpacing, deviceClearance, scripts} = data;
  try {
    if (!self.NbCableEditorRouting) importScripts(...scripts);
    const routes = self.NbCableEditorRouting.routeCables(connections, obstacles, bounds, protectedAreas,
      {strategy, spacing, horizontalSpacing, deviceClearance});
    self.postMessage({paths: Array.from(routes)});
  } catch {
    self.postMessage({error: true});
  }
});
