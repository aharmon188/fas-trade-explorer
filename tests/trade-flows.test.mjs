import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTradeFlows, monthlyFlowMaximum, tradeFlowPath, tradeFlowStyle, EUROPE_FLOW_SCALE, US_TRADE_HUB } from "../prototype/trade-flows.ts";
import { createTradeFlowOverlay, tradeFlowGraphics } from "../prototype/trade-flow-overlay.ts";
import { aggregateFacts, commodityFactIds } from "../prototype/overview-aggregation.ts";

const data = JSON.parse(readFileSync(new URL("../public/prototype-data.json", import.meta.url), "utf8"));
function trades(direction, commodity = "all", months = data.months) {
  const ids = commodityFactIds(data.commodities, direction, commodity);
  return data.partners.map(p => ({ ...p, ...aggregateFacts(data.records, [p.code], ids, direction, months) }));
}
const europe = new Set(["UK", "GM", "NL", "F1", "I1", "SP"]);

test("monthly intensity maximum covers all twelve frames for each displayed route configuration", () => {
  for (const direction of ["exports", "imports"]) {
    const months = data.months.map(month => trades(direction, "all", [month]));
    for (const scale of [EUROPE_FLOW_SCALE, EUROPE_FLOW_SCALE - 1]) {
      for (const selected of ["all", "F1"]) {
        const frames = months.map(partners => buildTradeFlows(partners, direction, scale, selected));
        const expected = Math.max(0, ...frames.flat().filter(flow => flow.complete).map(flow => flow.value ?? 0));
        const maximum = monthlyFlowMaximum(months, direction, scale, selected);
        assert.equal(maximum, expected);
        assert.ok(maximum > 0);
        for (const flows of frames) {
          for (const graphic of tradeFlowGraphics(flows, direction, maximum)) {
            const flow = flows.find(flow => flow.id === graphic.attributes.flowId);
            assert.equal(graphic.symbol.width, tradeFlowStyle(flow, maximum, direction).width);
          }
        }
      }
    }
  }
});

test("fixed monthly scale preserves equal values and does not exaggerate low-value frames", () => {
  const flow = buildTradeFlows(trades("exports"), "exports", EUROPE_FLOW_SCALE)[0];
  const low = { ...flow, value: 25, complete: true };
  const high = { ...flow, value: 100, complete: true };
  const lowGraphic = tradeFlowGraphics([low], "exports", 100)[0];
  const sameValue = tradeFlowGraphics([low, high], "exports", 100).find(g => g.attributes.valueUsd === 25);
  assert.equal(lowGraphic.symbol.width, sameValue.symbol.width);
  assert.ok(lowGraphic.symbol.width < tradeFlowGraphics([low], "exports")[0].symbol.width);
  assert.equal(monthlyFlowMaximum([[{ ...trades("exports")[0], complete: false, value: 1e15 }]], "exports", 1), 0);
  assert.throws(() => tradeFlowGraphics([low], "exports", NaN), /maximum/);
});

test("import arrows are individual partner-to-US routes at every scale", () => {
  for (const scale of [150_000_000, EUROPE_FLOW_SCALE, 5_000_000]) {
    const partners = trades("imports");
    const flows = buildTradeFlows(partners, "imports", scale);
    assert.equal(flows.length, 20);
    assert.equal(flows.some(f => f.region), false);
    for (const flow of flows) {
      assert.deepEqual(flow.destination, US_TRADE_HUB);
      assert.notDeepEqual(flow.origin, US_TRADE_HUB);
      assert.equal(flow.value, partners.find(p => p.code === flow.id).value);
    }
  }
});

test("world-scale Europe exports replace exactly their constituent country arrows with one safe sum", () => {
  for (const commodity of ["all", "wheat", "corn"]) {
    const partners = trades("exports", commodity);
    const flows = buildTradeFlows(partners, "exports", EUROPE_FLOW_SCALE);
    assert.equal(flows.length, 15);
    const regional = flows.find(f => f.region);
    assert.deepEqual([...regional.partnerCodes].sort(), [...europe].sort());
    assert.equal(regional.value, partners.filter(p => europe.has(p.code)).reduce((sum, p) => sum + (p.value ?? 0), 0));
    assert.equal(regional.expected, partners.filter(p => europe.has(p.code)).reduce((sum, p) => sum + p.expected, 0));
    assert.equal(flows.some(f => europe.has(f.id)), false);
    assert.deepEqual(flows.flatMap(f => f.partnerCodes).sort(), data.partners.map(p => p.code).sort());
    assert.equal(flows.reduce((sum, f) => sum + (f.value ?? 0), 0), partners.reduce((sum, p) => sum + (p.value ?? 0), 0));
    assert.ok(flows.every(f => f.origin[0] === US_TRADE_HUB[0] && f.origin[1] === US_TRADE_HUB[1]));
  }
});

test("zoom splits Europe and selecting any country shows only its own arrow at any scale", () => {
  const partners = trades("exports");
  const zoomed = buildTradeFlows(partners, "exports", EUROPE_FLOW_SCALE - 1);
  assert.equal(zoomed.length, 20);
  assert.equal(zoomed.some(f => f.region), false);
  for (const scale of [EUROPE_FLOW_SCALE + 1, EUROPE_FLOW_SCALE - 1]) {
    const france = buildTradeFlows(partners, "exports", scale, "F1");
    assert.equal(france.length, 1);
    assert.equal(france[0].id, "F1");
    assert.equal(france[0].value, partners.find(p => p.code === "F1").value);
  }
});

test("regional missing data stays partial or unknown, never a complete zero", () => {
  const missing = trades("exports").map(p => europe.has(p.code)
    ? { ...p, value: null, observed: 0, complete: false } : p);
  const unknown = buildTradeFlows(missing, "exports", EUROPE_FLOW_SCALE).find(f => f.region);
  assert.equal(unknown.value, null);
  assert.equal(unknown.complete, false);
  assert.equal(unknown.observed, 0);
  const partial = buildTradeFlows(missing.map(p => p.code === "F1"
    ? { ...p, value: 100, observed: 1 } : p), "exports", EUROPE_FLOW_SCALE).find(f => f.region);
  assert.equal(partial.value, 100);
  assert.equal(partial.complete, false);
  assert.equal(partial.observed, 1);
});

test("trade value increases both brightness and modest thickness for complete flows", () => {
  for (const direction of ["imports", "exports"]) {
    let previous = null;
    for (const value of [0, 1, 100, 1000, 10000]) {
      const style = tradeFlowStyle({ value, complete: true }, 10000, direction);
      assert.ok(style.width >= 0.9 && style.width <= 4);
      assert.equal(style.dashed, false);
      if (previous) {
        assert.ok(style.width > previous.width);
        assert.ok(style.color.slice(0, 3).reduce((a, b) => a + b, 0) >= previous.color.slice(0, 3).reduce((a, b) => a + b, 0));
        assert.ok(style.color[3] > previous.color[3]);
      }
      previous = style;
    }
    assert.deepEqual(tradeFlowStyle({ value: 1e12, complete: false }, 100, direction),
      tradeFlowStyle({ value: null, complete: false }, 100, direction));
    assert.ok(tradeFlowStyle({ value: null, complete: false }, 100, direction).dashed);
    assert.ok(Number.isFinite(tradeFlowStyle({ value: 0, complete: true }, 0, direction).width));
  }
});

test("curved arrow paths connect both endpoints and cross the Pacific without a dateline jump", () => {
  const radius = 6378137;
  for (const direction of ["exports", "imports"]) {
    const flows = buildTradeFlows(trades(direction), direction, 1_000_000);
    for (const flow of flows) {
      const path = tradeFlowPath(flow.origin, flow.destination);
      assert.equal(path.length, 49);
      assert.ok(path.flat().every(Number.isFinite));
      assert.ok(Math.abs(path[0][0] - radius * flow.origin[0] * Math.PI / 180) < 1e-6);
      const endLon = path.at(-1)[0] / radius * 180 / Math.PI;
      assert.ok(Math.abs(((endLon - flow.destination[0]) % 360 + 360) % 360) < 1e-6 ||
        Math.abs(((endLon - flow.destination[0]) % 360 + 360) % 360 - 360) < 1e-6);
      assert.ok(Math.abs(path.at(-1)[0] - path[0][0]) <= radius * Math.PI);
      for (let i = 1; i < path.length; i++) assert.ok(Math.abs(path[i][0] - path[i - 1][0]) < 1_000_000);
    }
  }
});

test("ArcGIS graphics have arrowheads at the destination and remain display-only", () => {
  const flows = buildTradeFlows(trades("exports"), "exports", EUROPE_FLOW_SCALE);
  const layer = createTradeFlowOverlay();
  layer.addMany(tradeFlowGraphics(flows, "exports"));
  assert.equal(layer.type, "graphics");
  assert.equal(layer.graphics.length, 15);
  for (const graphic of layer.graphics) {
    assert.equal(graphic.geometry.type, "polyline");
    assert.equal(graphic.geometry.spatialReference.wkid, 3857);
    assert.equal(graphic.symbol.marker.placement, "end");
    assert.equal(graphic.symbol.marker.style, "arrow");
    assert.ok(graphic.attributes.valueLabel.startsWith("$"));
  }
  const region = layer.graphics.find(g => g.attributes.region);
  assert.equal(region.attributes.partnerCode, null);
  assert.match(region.attributes.coverageLabel, /Selected European partners only/);
  const zero = { ...flows[0], value: 0, complete: true };
  assert.equal(tradeFlowGraphics([zero], "exports").length, 0);
  const partial = tradeFlowGraphics([{ ...zero, complete: false }], "exports")[0];
  assert.equal(partial.symbol.style, "dash");
  assert.match(partial.attributes.valueLabel, /partial/);
  layer.destroy();
});

test("flow inputs reject unavailable anchors, duplicate partners, invalid values and invalid selection", () => {
  const partners = trades("exports");
  assert.throws(() => buildTradeFlows([...partners, partners[0]], "exports", 1), /Duplicate/);
  assert.throws(() => buildTradeFlows([{ ...partners[0], code: "ZZ" }], "exports", 1), /anchor/);
  assert.throws(() => buildTradeFlows([{ ...partners[0], value: -1 }], "exports", 1), /Invalid/);
  assert.throws(() => buildTradeFlows(partners, "exports", 0), /scale/);
  assert.throws(() => buildTradeFlows(partners, "exports", 1, "ZZ"), /coverage/);
});
