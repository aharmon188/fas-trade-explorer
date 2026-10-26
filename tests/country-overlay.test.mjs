import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import WebMap from "@arcgis/core/WebMap.js";
import { createCountryOverlay } from "../prototype/country-overlay.ts";
import { createTradeFlowOverlay } from "../prototype/trade-flow-overlay.ts";

// Exercise the installed SDK's actual registry restoration, without credentials or an LLM request.
const sdk = readFileSync(new URL("../node_modules/@arcgis/ai-components/dist/chunks/orchestrator.js", import.meta.url), "utf8");
const start = sdk.indexOf("ce = (t, e) => {") + 5;
const end = sdk.indexOf(", de = async", start);
assert.ok(start > 4 && end > start, "SDK restoration seam changed; update this regression harness");
const restore = vm.runInNewContext(`(${sdk.slice(start, end)})`, { T: FeatureLayer, Map });

test("country display overlay preserves the embedded web map's feature-layer registry", () => {
  const map = new WebMap();
  map.add(new FeatureLayer({ id: "trade-facts", fields: [] }));
  const embeddings = [{ id: "trade-facts", fields: [] }];
  assert.equal(restore(embeddings, map).size, 1);
  map.add(createCountryOverlay([]));
  map.add(createTradeFlowOverlay());
  map.basemap = "dark-gray-vector";
  assert.equal(restore(embeddings, map).size, 1);
  map.destroy();
});

test("registry harness detects the original extra-feature-layer bug", () => {
  const map = new WebMap();
  map.add(new FeatureLayer({ id: "trade-facts", fields: [] }));
  map.add(new FeatureLayer({ id: "display-overlay", fields: [] }));
  assert.throws(() => restore([{ id: "trade-facts", fields: [] }], map),
    /Layer count mismatch during registry restoration\. Regenerate embeddings\./);
  map.destroy();
});
