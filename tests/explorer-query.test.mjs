import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  parseQuestion, validateQuery, applyQuery, answerQuery, rankPartners, summarize, emptyQuery, CAVEAT,
} from "../prototype/explorer-query.ts";

const months = ["202509", "202510", "202511", "202512", "202601", "202602", "202603", "202604", "202605", "202606", "202607", "202608"];
const catalog = {
  partners: [{ code: "CA", name: "Canada" }, { code: "MX", name: "Mexico" }, { code: "BR", name: "Brazil" }, { code: "JA", name: "Japan" }, { code: "CH", name: "China" }],
  commodities: [{ id: "wheat", name: "Wheat" }, { id: "corn", name: "Corn" }, { id: "soybeans", name: "Soybeans" }, { id: "rice", name: "Rice" }],
  months,
};
const state = { partner: "CA", commodity: "wheat", direction: "exports", metric: "valueUsd", period: "all" };

const fixture = (() => {
  const records = [];
  const vals = { CA: 100, MX: 300, BR: 50, JA: 200, CH: null };
  for (const p of catalog.partners) for (const m of months) {
    const v = vals[p.code];
    // Brazil is missing two months; China has no rows at all.
    const missing = v === null || (p.code === "BR" && (m === "202510" || m === "202511"));
    records.push({ partnerCode: p.code, commodityId: "wheat", month: m, direction: "exports",
      valueUsd: missing ? null : v, quantityMt: missing ? null : v / 10 });
  }
  return { ...catalog, commodities: [{ id: "wheat", name: "Wheat", description: "Inferred HS1001." }, ...catalog.commodities.slice(1)], records };
})();

test("parser maps plain questions to closed-vocabulary queries", () => {
  assert.deepEqual(parseQuestion("Show corn exports to Japan in March 2026", catalog),
    { schemaVersion: 1, intent: "set_view", partner: "JA", commodity: "corn", direction: "exports", metric: null, period: { type: "month", month: "202603" }, message: null });
  const q = parseQuestion("How many tons of rice did we import from Brazil last month?", catalog);
  assert.equal(q.partner, "BR"); assert.equal(q.commodity, "rice"); assert.equal(q.direction, "imports");
  assert.equal(q.metric, "quantityMt"); assert.deepEqual(q.period, { type: "month", month: "202608" });
  assert.equal(parseQuestion("maize exports to China", catalog).commodity, "corn");
  assert.equal(parseQuestion("Which partner buys the most wheat?", catalog).intent, "rank");
  assert.equal(parseQuestion("wheat exports to Mexico trend", catalog).intent, "trend");
  assert.equal(parseQuestion("What does the wheat definition include?", catalog).intent, "explain");
});

test("parser refuses or asks instead of guessing", () => {
  assert.equal(parseQuestion("wheat exports to Germany", catalog).intent, "unsupported");
  assert.equal(parseQuestion("wheat exports to Japan in March 2020", catalog).intent, "unsupported");
  assert.equal(parseQuestion("wheat exports to Japan in July 2026", catalog).intent, "set_view");
  assert.equal(parseQuestion("wheat exports to Japan in September", catalog).period.month, "202509");
  assert.equal(parseQuestion("exports and imports of wheat", catalog).intent, "clarify");
  assert.equal(parseQuestion("value in tons of wheat", catalog).intent, "clarify");
  assert.equal(parseQuestion("wheat exports to Japan or China", catalog).intent, "clarify");
  assert.equal(parseQuestion("corn or soybeans to Japan", catalog).intent, "clarify");
  assert.equal(parseQuestion("wheat exports to Japan over the last 3 months", catalog).intent, "unsupported");
  assert.equal(parseQuestion("tell me a joke", catalog).intent, "clarify");
  assert.equal(parseQuestion("   ", catalog).intent, "clarify");
});

test("validator accepts parser output and rejects invented or malformed values", () => {
  const good = parseQuestion("corn exports to Japan in March 2026", catalog);
  assert.equal(validateQuery(good, catalog).ok, true);
  const bad = (patch) => validateQuery({ ...good, ...patch }, catalog);
  for (const patch of [
    { partner: "JP" }, { partner: "Japan" }, { commodity: "barley" }, { direction: "both" }, { metric: "price" },
    { period: { type: "month", month: "202001" } }, { period: { type: "range", from: "202509", to: "202510" } },
    { period: { type: "all", extra: 1 } }, { intent: "delete" }, { schemaVersion: 2 }, { message: "hi" },
    { sql: "drop table" },
  ]) assert.equal(bad(patch).ok, false, JSON.stringify(patch));
  assert.equal(validateQuery(emptyQuery("clarify"), catalog).ok, false);
  assert.equal(validateQuery(emptyQuery("clarify", "x".repeat(301)), catalog).ok, false);
  assert.equal(validateQuery(emptyQuery("clarify", "Pick one."), catalog).ok, true);
  const { schemaVersion, ...partial } = good;
  assert.equal(validateQuery(partial, catalog).ok, false);
  for (const junk of [null, undefined, "x", 3, [], [good]]) assert.equal(validateQuery(junk, catalog).ok, false);
});

test("applyQuery only changes specified fields and ignores clarify/unsupported", () => {
  const q = parseQuestion("corn imports from Japan", catalog);
  const result = applyQuery(state, q);
  assert.deepEqual(result.state, { ...state, partner: "JA", commodity: "corn", direction: "imports" });
  assert.deepEqual(result.changed.sort(), ["commodity", "direction", "partner"]);
  assert.equal(applyQuery(state, emptyQuery("clarify", "Pick one.")).state, state);
  assert.deepEqual(applyQuery(state, parseQuestion("show the full 12 months", catalog)).state, state);
});

test("ranking puts complete results first and never treats unknown as zero", () => {
  const ranked = rankPartners(fixture, state);
  assert.deepEqual(ranked.map(r => r.code), ["MX", "JA", "CA", "BR", "CH"]);
  const br = ranked.find(r => r.code === "BR");
  assert.equal(br.complete, false); assert.equal(br.observed, 10); assert.equal(br.value, 500);
  const ch = ranked.find(r => r.code === "CH");
  assert.equal(ch.value, null); assert.equal(ch.observed, 0);
});

test("answers are computed from data, labeled partial, and carry the caveat", () => {
  const lines = answerQuery(fixture, { ...state, partner: "BR" }, parseQuestion("wheat exports to Brazil", catalog));
  assert.match(lines[0], /\$500 .*partial: 10\/12/);
  assert.match(lines[0], /unknown, not zero/);
  assert.equal(lines.at(-1), CAVEAT);
  const rank = answerQuery(fixture, state, parseQuestion("which partner buys the most wheat", catalog));
  assert.match(rank[0], /not a world ranking/);
  assert.match(rank.join("\n"), /5\. China: no reported rows/);
  assert.match(answerQuery(fixture, state, parseQuestion("what does the wheat definition include", catalog))[0], /Inferred HS1001/);
  assert.deepEqual(answerQuery(fixture, state, parseQuestion("exports to Germany", catalog)).length, 1);
  assert.equal(answerQuery(fixture, state, parseQuestion("wheat trend", catalog)).length, 14);
});

const dataFile = new URL("../public/prototype-data.json", import.meta.url);
test("real pilot data reproduces the reconciled Canada wheat August 2026 export", { skip: !existsSync(dataFile) }, () => {
  const data = JSON.parse(readFileSync(dataFile, "utf8"));
  const s = { partner: "CA", commodity: "wheat", direction: "exports", metric: "valueUsd", period: "202608" };
  assert.equal(validateQuery(parseQuestion("wheat exports to Canada in August 2026", data), data).ok, true);
  assert.equal(summarize(data, s).value, 3162605);
  assert.equal(summarize(data, { ...s, metric: "quantityMt" }).value, 9962);
});
