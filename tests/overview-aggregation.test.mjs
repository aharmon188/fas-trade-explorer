import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aggregateFacts, commodityFactIds } from "../prototype/overview-aggregation.ts";

const commodities = [
  { id: "all-bulk", kind: "category", directions: ["exports", "imports"] },
  { id: "all-intermediate", kind: "category", directions: ["exports", "imports"] },
  { id: "all-related", kind: "category", directions: ["imports"] },
  { id: "wheat", kind: "group", directions: ["exports", "imports"] },
  { id: "corn", kind: "group", directions: ["exports"] },
];

test("all commodities selects direction-specific category rollups, never groups", () => {
  assert.deepEqual(commodityFactIds(commodities, "exports", "all"), ["all-bulk", "all-intermediate"]);
  assert.deepEqual(commodityFactIds(commodities, "imports", "all"), ["all-bulk", "all-intermediate", "all-related"]);
  assert.deepEqual(commodityFactIds(commodities, "exports", "wheat"), ["wheat"]);
  assert.throws(() => commodityFactIds(commodities, "imports", "corn"), /No commodity facts/);
});

test("source HS10 membership is disjoint within each trade direction", () => {
  for (const direction of ["exports", "imports"]) {
    const crosswalk = JSON.parse(readFileSync(
      new URL(`../prototype/bico-crosswalk-${direction}.json`, import.meta.url),
      "utf8",
    ));
    const members = crosswalk.members.map(member => member.hs10);
    assert.equal(new Set(members).size, members.length, `${direction} crosswalk has overlapping HS10 assignments`);
  }
});

test("overview totals aggregate each selected category and partner once, preserving unknowns", () => {
  const records = [
    { partnerCode: "CA", commodityId: "all-bulk", month: "202601", direction: "exports", valueUsd: 100 },
    { partnerCode: "CA", commodityId: "all-intermediate", month: "202601", direction: "exports", valueUsd: 20 },
    { partnerCode: "CA", commodityId: "all-bulk", month: "202602", direction: "exports", valueUsd: 110 },
    { partnerCode: "CA", commodityId: "all-intermediate", month: "202602", direction: "exports", valueUsd: null },
    { partnerCode: "CA", commodityId: "wheat", month: "202601", direction: "exports", valueUsd: 80 },
    { partnerCode: "MX", commodityId: "all-bulk", month: "202601", direction: "exports", valueUsd: 500 },
  ];
  const categories = commodityFactIds(commodities, "exports", "all");
  assert.deepEqual(
    aggregateFacts(records, ["CA"], categories, "exports", ["202601", "202602"]),
    { value: 230, observed: 3, expected: 4, complete: false },
  );
  assert.deepEqual(
    aggregateFacts(records, ["CA", "MX"], categories, "exports", ["202601"]),
    { value: 620, observed: 3, expected: 4, complete: false },
  );
});

test("aggregation rejects duplicate facts instead of silently counting them twice", () => {
  const fact = { partnerCode: "CA", commodityId: "all-bulk", month: "202601", direction: "exports", valueUsd: 10 };
  assert.throws(
    () => aggregateFacts([fact, fact], ["CA"], ["all-bulk"], "exports", ["202601"]),
    /Duplicate fact/,
  );
});
