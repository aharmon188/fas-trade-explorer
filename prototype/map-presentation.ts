import Point from "@arcgis/core/geometry/Point.js";
import Viewpoint from "@arcgis/core/Viewpoint.js";
import type MapView from "@arcgis/core/views/MapView.js";

export const SIGNIN_VIEWPOINT_KEY = "fas-signin-viewpoint";

export function initializeMapViewpoint(
  view: Pick<MapView, "viewpoint">,
  savedViewpoint: string | null,
): void {
  if (savedViewpoint !== null) {
    const json: unknown = JSON.parse(savedViewpoint);
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new Error("The saved sign-in viewpoint is invalid.");
    }
    const viewpoint = Viewpoint.fromJSON(json);
    if (!viewpoint.targetGeometry || !Number.isFinite(viewpoint.scale) || viewpoint.scale <= 0) {
      throw new Error("The saved sign-in viewpoint has no valid geometry or scale.");
    }
    view.viewpoint = viewpoint;
  } else {
    view.viewpoint = new Viewpoint({
      targetGeometry: new Point({ longitude: 0, latitude: 22 }),
      scale: 147914381.8978885,
      rotation: 0,
    });
  }
}
