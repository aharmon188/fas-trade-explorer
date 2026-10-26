import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import type Graphic from "@arcgis/core/Graphic.js";

export function createCountryOverlay(graphics: Graphic[]) {
  // Display-only graphics must not change the feature-layer registry stored in AI embeddings.
  return new GraphicsLayer({ id: "country-display", title: "Partner comparison", graphics, listMode: "hide" });
}
