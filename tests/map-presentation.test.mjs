import test from "node:test";
import assert from "node:assert/strict";
import Point from "@arcgis/core/geometry/Point.js";
import Viewpoint from "@arcgis/core/Viewpoint.js";
import { initializeMapViewpoint } from "../prototype/map-presentation.ts";

test("initial framing overrides an excessively zoomed-out saved web-map viewpoint", () => {
  const view = { center: new Point({ longitude: 0, latitude: 0 }), zoom: 0, viewpoint: null };
  initializeMapViewpoint(view, null);
  assert.equal(view.viewpoint.scale, 147914381.8978885);
  assert.equal(view.viewpoint.targetGeometry.latitude, 22);
});

test("sign-in restoration preserves geometry, scale, and rotation", () => {
  const before = new Viewpoint({
    targetGeometry: new Point({ longitude: -98, latitude: 40 }),
    scale: 12345678,
    rotation: 12,
  });
  const view = { center: null, zoom: 0, viewpoint: null };
  initializeMapViewpoint(view, JSON.stringify(before.toJSON()));
  assert.deepEqual(view.viewpoint.toJSON(), before.toJSON());
  assert.throws(() => initializeMapViewpoint(view, "{}"), /no valid geometry or scale/);
});
