"use strict";

self.importScripts("rack-corridors.js" + self.location.search, "rack-routing.js" + self.location.search);

self.addEventListener("message", ({data}) => {
  const {connections, obstacles, bounds, protectedAreas, strategy, spacing, horizontalSpacing, deviceClearance} = data;
  try {
    const routes = self.NbCableEditorRouting.routeCables(connections, obstacles, bounds, protectedAreas,
      {strategy, spacing, horizontalSpacing, deviceClearance});
    self.postMessage({paths: Array.from(routes)});
  } catch {
    self.postMessage({error: true});
  }
});
