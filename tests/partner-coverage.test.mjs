import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Graphic from "@arcgis/core/Graphic.js";
import { executeTradeQuery, tradeCatalog } from "../prototype/trade-calculation.ts";
import { createTradeAgent } from "../prototype/trade-agent.ts";
import { createCountryOverlay } from "../prototype/country-overlay.ts";

const data = JSON.parse(readFileSync(new URL("../public/prototype-data.json", import.meta.url), "utf8"));
const configured = JSON.parse(readFileSync(new URL("../prototype/partners.json", import.meta.url), "utf8"));
const boundaries = JSON.parse(readFileSync(new URL("../public/partner-boundaries.geojson", import.meta.url), "utf8"));

test("prepared coverage matches twenty selected individual countries, not a claimed global top twenty", () => {
  assert.equal(configured.length, 20);
  assert.deepEqual(data.partners, configured);
  assert.equal(new Set(data.partners.map(p => p.code)).size, 20);
  assert.equal(new Set(data.partners.map(p => p.iso)).size, 20);
  assert.deepEqual(data.months, ["202509", "202510", "202511", "202512", "202601", "202602",
    "202603", "202604", "202605", "202606", "202607", "202608"]);
  assert.match(data.selectionBasis, /not a computed top-20/);
  assert.equal(data.records.length, data.partners.length * data.months.length *
    data.commodities.reduce((count, commodity) => count + commodity.directions.length, 0));
  assert.deepEqual(tradeCatalog(data).partners, configured);
});

test("every country/month/direction has disjoint category totals equal to observed constituent groups", () => {
  const cells = new Map();
  const definitions = new Map(data.commodities.map(c => [c.id, c]));
  const keys = new Set();
  for (const record of data.records) {
    const key = `${record.partnerCode}/${record.direction}/${record.month}/${record.commodityId}`;
    assert.ok(!keys.has(key), `Duplicate fact ${key}`);
    keys.add(key);
    assert.ok(record.valueUsd === null || Number.isSafeInteger(record.valueUsd) && record.valueUsd >= 0);
    assert.equal(record.valueUsd === null, record.status === "no_reported_rows");
    const commodity = definitions.get(record.commodityId);
    const category = commodity.groups[record.direction].category;
    const cellKey = `${record.partnerCode}/${record.direction}/${record.month}/${category}`;
    const cell = cells.get(cellKey) ?? { category: null, groups: [], hasCategory: false };
    if (commodity.kind === "category") {
      assert.equal(cell.hasCategory, false);
      cell.category = record.valueUsd;
      cell.hasCategory = true;
    } else if (record.valueUsd !== null) cell.groups.push(record.valueUsd);
    cells.set(cellKey, cell);
  }
  for (const [key, cell] of cells) {
    assert.ok(cell.hasCategory, key);
    assert.equal(cell.category, cell.groups.length ? cell.groups.reduce((sum, value) => sum + value, 0) : null, key);
  }
});

test("expanded totals and numeric partner rankings use all twenty countries exactly once", () => {
  for (const direction of ["exports", "imports"]) {
    const selection = { partners: "all", commodities: "all", direction, period: { type: "full_window" } };
    const categories = new Set(data.commodities.filter(c => c.kind === "category" && c.directions.includes(direction)).map(c => c.id));
    const expected = new Map(data.partners.map(p => [p.code, 0]));
    for (const r of data.records) if (r.direction === direction && categories.has(r.commodityId) && r.valueUsd !== null) {
      expected.set(r.partnerCode, expected.get(r.partnerCode) + r.valueUsd);
    }
    const result = executeTradeQuery(data, { schemaVersion: 2, action: { operation: "aggregate", selection, groupBy: "partner" } });
    assert.equal(result.rows.length, 20);
    for (const row of result.rows) assert.equal(row.value, expected.get(row.key), row.key);
    const total = executeTradeQuery(data, { schemaVersion: 2, action: { operation: "aggregate", selection, groupBy: "none" } });
    assert.equal(total.rows[0].value, [...expected.values()].reduce((sum, value) => sum + value, 0));
    const ranked = executeTradeQuery(data, { schemaVersion: 2, action: {
      operation: "rank", selection, groupBy: "partner", order: "descending", startRank: 1, count: 20,
    } });
    assert.deepEqual(ranked.rows.map(r => r.key), [...expected.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code));
  }
});

test("all twenty map geometries remain display-only graphics, including Taiwan and Spain", () => {
  const isos = boundaries.features.map(f => f.properties.ISO);
  assert.equal(isos.length, 20);
  assert.equal(new Set(isos).size, 20);
  assert.deepEqual([...isos].sort(), data.partners.map(p => p.iso).sort());
  assert.ok(isos.includes("TW") && isos.includes("ES"));
  const layer = createCountryOverlay(data.partners.map(p => new Graphic({ attributes: { partnerCode: p.code } })));
  assert.equal(layer.type, "graphics");
  assert.equal(layer.graphics.length, 20);
  layer.destroy();
});

test("SDK agent calculates newly added countries using their current FAS IDs", async () => {
  for (const code of ["F1", "I1", "A2", "KS", "VM"]) {
    const query = { schemaVersion: 2, action: {
      operation: "aggregate", groupBy: "none",
      selection: { partners: [code], commodities: "all", direction: "exports", period: { type: "full_window" } },
    } };
    const result = executeTradeQuery(data, query);
    assert.ok(result.rows[0].value > 0);
    const agent = createTradeAgent(data, async () => query);
    const request = `What was the export value to ${data.partners.find(p => p.code === code).name}?`;
    const executed = await agent.createGraph().compile().invoke({ agentExecutionContext: {
      userRequest: request, assignedTask: request, messages: [], priorSteps: [], sharedState: {},
    } });
    assert.equal(executed.status, "success");
    assert.match(executed.outputMessage, /\$/);
    assert.ok(executed.outputMessage.includes(data.partners.find(p => p.code === code).name));
  }
});
