import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTradeAgent, tradePromptOptions } from "../prototype/trade-agent.ts";
import { ChatPromptTemplate, SystemMessagePromptTemplate } from "@langchain/core/prompts";
import { calculateTradeAnswer, executeTradeQuery } from "../prototype/trade-calculation.ts";

const data = JSON.parse(readFileSync(new URL("../public/prototype-data.json", import.meta.url), "utf8"));
// Keep the original five-country ranking regressions scoped to their original candidate set.
const originalPartners = new Set(["CA", "MX", "BR", "JA", "CH"]);
data.partners = data.partners.filter(p => originalPartners.has(p.code));
data.records = data.records.filter(r => originalPartners.has(r.partnerCode));
const selection = {
  partners: "all", commodities: ["wheat"], direction: "exports", period: { type: "full_window" },
};
const query = { schemaVersion: 2, action: {
  operation: "rank", selection, groupBy: "partner", order: "descending", startRank: 1, count: 1,
} };
const context = request => ({ userRequest: request, assignedTask: request, messages: [], priorSteps: [], sharedState: {} });
const run = (agent, request) => agent.registration.createGraph().compile().invoke({ agentExecutionContext: context(request) });

test("SDK prompt template accepts catalog JSON and braces in user text as variable values", async () => {
  const request = "Which partner had the highest wheat exports? {not a template}";
  const options = tradePromptOptions(data, request, context(request), undefined, query);
  const prompt = ChatPromptTemplate.fromMessages([
    SystemMessagePromptTemplate.fromTemplate(options.promptText), ...options.messages,
  ]);
  const rendered = await prompt.format(options.inputVariables);
  assert.ok(rendered.includes(request));
  assert.ok(rendered.includes('"id":"wheat"'));
  assert.ok(rendered.includes('"startRank":1'));
});

test("actual SDK agent graph calculates full-window totals and second place from parameters", async () => {
  const first = await run(createTradeAgent(data, async () => query), "Which partner had the highest wheat exports?");
  assert.equal(first.status, "success");
  assert.match(first.outputMessage, /^Mexico is the partner with the highest value of wheat exports, at \$1,184,773,992\./);
  assert.doesNotMatch(first.outputMessage, /snapshot|facts observed|20261026|12\/12|\$126,343,112/);
  const second = await run(createTradeAgent(data, async () => ({
    ...query, action: { ...query.action, startRank: 2 },
  })), "Which partner has the second highest wheat export value?");
  assert.equal(second.status, "success");
  assert.match(second.outputMessage, /^Japan is the partner with the second-highest value of wheat exports, at \$581,518,786\./);
});

test("month-specific request uses its requested month, never a full-window total", () => {
  const result = executeTradeQuery(data, { ...query, action: {
    ...query.action, selection: { ...selection, period: { type: "months", months: ["202509"] } },
  } });
  assert.equal(result.rows[0].value, 126343112);
  assert.match(calculateTradeAnswer(data, result.query), /September 2025/);
});

test("ranks use numeric sums, dense ties, ascending order, and requested number of distinct ranks", () => {
  const tied = { ...data, records: data.records.filter(r => r.commodityId === "wheat" && r.direction === "exports")
    .map(r => ({ ...r, valueUsd: ["MX", "CA"].includes(r.partnerCode) ? 100 : 1 })) };
  const first = executeTradeQuery(tied, query);
  assert.deepEqual(first.rows.map(r => r.key).sort(), ["CA", "MX"]);
  assert.deepEqual(first.rows.map(r => r.rank), [1, 1]);
  const second = executeTradeQuery(tied, { ...query, action: { ...query.action, startRank: 2 } });
  assert.deepEqual(second.rows.map(r => r.key).sort(), ["BR", "CH", "JA"]);
  assert.ok(second.rows.every(r => r.rank === 2));
  const lowest = executeTradeQuery(tied, { ...query, action: { ...query.action, order: "ascending" } });
  assert.deepEqual(lowest.rows.map(r => r.key).sort(), ["BR", "CH", "JA"]);
  const topTwo = executeTradeQuery(tied, { ...query, action: { ...query.action, count: 2 } });
  assert.equal(topTwo.rows.length, 5, "Include all ties at selected dense ranks");
});

test("partial results stay in numeric order, unknowns are excluded from ranking, and coverage is disclosed", () => {
  const partial = { ...data, records: data.records.filter(r =>
    !(r.partnerCode === "MX" && r.commodityId === "wheat" && r.direction === "exports" && r.month === "202509")) };
  const result = executeTradeQuery(partial, query);
  assert.equal(result.rows[0].key, "MX");
  assert.equal(result.rows[0].value, 1058430880);
  assert.equal(result.rows[0].observed, 11);
  assert.equal(result.rows[0].expected, 12);
  assert.match(calculateTradeAnswer(partial, query), /partial total.*Coverage is incomplete/);
  const all = executeTradeQuery(data, { ...query, action: { ...query.action, count: 5 } });
  assert.deepEqual(all.rows.map(r => r.key), ["MX", "JA", "CH", "CA", "BR"], "Do not demote partial values behind smaller complete values");
  const unknown = executeTradeQuery({ ...data, records: [] }, query);
  assert.equal(unknown.rows.length, 0);
  assert.equal(unknown.unknown, 5);
  assert.match(calculateTradeAnswer({ ...data, records: [] }, query), /No reported value/);
});

test("all commodities totals use categories only, commodity grouping enumerates groups only", () => {
  for (const direction of ["exports", "imports"]) {
    const result = executeTradeQuery(data, { schemaVersion: 2, action: {
      operation: "aggregate", groupBy: "partner", selection: { ...selection, commodities: "all", direction },
    } });
    const ids = new Set(data.commodities.filter(c => c.kind === "category" && c.directions.includes(direction)).map(c => c.id));
    const expected = data.records.filter(r => r.partnerCode === "CA" && r.direction === direction && ids.has(r.commodityId))
      .reduce((sum, r) => sum + r.valueUsd, 0);
    assert.equal(result.rows.find(r => r.key === "CA").value, expected);
    const grouped = executeTradeQuery(data, { schemaVersion: 2, action: {
      operation: "aggregate", groupBy: "commodity", selection: { ...selection, commodities: "all", direction },
    } });
    assert.ok(grouped.rows.every(r => data.commodities.find(c => c.id === r.key).kind === "group"));
  }
});

test("invalid/duplicate/overlapping selections and unavailable direction groups fail explicitly", () => {
  for (const patch of [
    { partners: ["ZZ"] }, { partners: ["CA", "CA"] },
    { commodities: ["wheat", "wheat"] }, { commodities: ["all-bulk", "wheat"] },
    { commodities: ["corn"], direction: "imports" },
    { period: { type: "months", months: ["202001"] } },
    { period: { type: "months", months: ["202601", "202601"] } },
    { period: { type: "range", from: "202608", to: "202601" } },
  ]) assert.throws(() => executeTradeQuery(data, { ...query, action: { ...query.action, selection: { ...selection, ...patch } } }), undefined, JSON.stringify(patch));
  assert.throws(() => executeTradeQuery(data, { ...query, action: { ...query.action, startRank: 0 } }));
  assert.throws(() => executeTradeQuery(data, { ...query, action: { ...query.action, count: 0 } }));
});

const compare = (calculation, left, right) => ({ schemaVersion: 2, action: {
  operation: "compare", calculation, left, right,
} });
test("comparisons calculate dollars, change, ratio, and subset share without LLM arithmetic", () => {
  const ca = { ...selection, partners: ["CA"] };
  const mx = { ...selection, partners: ["MX"] };
  const difference = executeTradeQuery(data, compare("difference", ca, mx));
  assert.equal(difference.difference, 1184773992 - 38300729);
  const ratio = executeTradeQuery(data, compare("ratio", ca, mx));
  assert.equal(ratio.ratio, 38300729 / 1184773992);
  const share = executeTradeQuery(data, compare("share", mx, { ...mx, commodities: "all" }));
  assert.ok(share.percentage > 0 && share.percentage < 100);
  assert.throws(() => executeTradeQuery(data, compare("share", mx, ca)), /subset/);
  assert.throws(() => executeTradeQuery(data, compare("share", { ...mx, direction: "imports" }, mx)), /same trade direction/);
});

test("comparison baseline zero, missing values, and partial totals never produce invented percentages", () => {
  const ca = { ...selection, partners: ["CA"] };
  const empty = executeTradeQuery({ ...data, records: [] }, compare("change", ca, ca));
  assert.equal(empty.percentage, null);
  assert.equal(empty.difference, null);
  assert.match(empty.reason, /incomplete/);
  const zero = { ...data, records: data.records.map(r => ({ ...r, valueUsd: 0 })) };
  const result = executeTradeQuery(zero, compare("change", ca, ca));
  assert.equal(result.percentage, null);
  assert.equal(result.difference, 0);
  assert.match(result.reason, /zero/);
  assert.doesNotMatch(calculateTradeAnswer(zero, result.query), /NaN|Infinity/);
  const partial = executeTradeQuery(data, compare("difference", { ...ca, partners: ["CH"] }, ca));
  assert.equal(partial.difference, null);
  assert.match(partial.reason, /incomplete/);
});

test("graph preserves the last validated plan explicitly across follow-ups, not failed or clarification requests", async () => {
  let call = 0;
  const agent = createTradeAgent(data, async (_request, _context, _config, previous) => {
    call++;
    if (call === 1) { assert.equal(previous, null); return query; }
    assert.equal(previous.action.startRank, call === 2 ? 1 : 2);
    if (call === 2) return { ...previous, action: { ...previous.action, startRank: 2 } };
    if (call === 3) return { schemaVersion: 2, action: { operation: "clarify", message: "Which period?" } };
    if (call === 4) return { ...query, badField: 3 };
    return previous;
  });
  await run(agent, "Which partner had the highest wheat exports?");
  assert.match((await run(agent, "Who came second?")).outputMessage, /Japan/);
  assert.equal((await run(agent, "For what period?")).outputMessage, "Which period?");
  assert.equal((await run(agent, "Invalid request")).status, "failed");
  assert.match((await run(agent, "Repeat that")).outputMessage, /Japan/);
});

test("graph reports malformed model output as failure rather than silently changing the question", async () => {
  const result = await run(createTradeAgent(data, async () => ({ ...query, value: 126343112 })), "wheat exports");
  assert.equal(result.status, "failed");
  assert.match(result.outputMessage, /Unrecognized key/);
});

test("follow-up memory is reset for a new SDK conversation and definitions do not replace analytical context", async () => {
  let call = 0;
  const agent = createTradeAgent(data, async (_request, _context, _config, previous) => {
    call++;
    if (call === 1 || call === 4) assert.equal(previous, null);
    else assert.equal(previous.action.startRank, 1);
    if (call === 2) return { schemaVersion: 2, action: { operation: "explain", selection } };
    return query;
  });
  const graph = agent.createGraph().compile();
  const invoke = thread => graph.invoke({ agentExecutionContext: context("Wheat exports") }, { configurable: { thread_id: thread } });
  await invoke("conversation-a");
  await invoke("conversation-a");
  await invoke("conversation-a");
  await invoke("conversation-b");
  assert.equal(call, 4);
});
