"use strict";

self.addEventListener("message", ({data}) => {
  const {connections, obstacles, bounds, protectedAreas, strategy, spacing, deviceClearance, scripts} = data;
  try {
    if (!self.NetBoxRackRouting) importScripts(...scripts);
    const routes = self.NetBoxRackRouting.routeCables(connections, obstacles, bounds, protectedAreas, {strategy, spacing, deviceClearance});
    self.postMessage({paths: Array.from(routes)});
  } catch {
    self.postMessage({error: true});
  }
});
