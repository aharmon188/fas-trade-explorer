import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TRADE_ACCEPTANCE_CASES, evaluateTradeAcceptance } from "../prototype/trade-acceptance.ts";
import { executeTradeQuery, formatTradeResult, tradeQuerySchema } from "../prototype/trade-calculation.ts";
import { createTradeAgent } from "../prototype/trade-agent.ts";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

const data = JSON.parse(readFileSync(new URL("../public/prototype-data.json", import.meta.url), "utf8"));
// Numerical acceptance baselines describe the original five-country pilot.
const originalPartners = new Set(["CA", "MX", "BR", "JA", "CH"]);
data.partners = data.partners.filter(p => originalPartners.has(p.code));
data.records = data.records.filter(r => originalPartners.has(r.partnerCode));
const expectedRows = [
  [["total", 1184773992]],
  [["JA", 581518786]],
  [["bakery-goods-cereals-and-pasta", 2636633330], ["fresh-vegetables", 1994530880], ["forest-products", 1993594614]],
  [["total", 50566270]],
  [1184773992, 38300729, -1146473263],
  [3407062, 2775041, -632021],
  [3283741112, 1133169978, -2150571134],
  [32232729179, 53937377661, 21704648482],
  [["202509", 126343112]],
  [584532665, 15718184610, 15133651945],
];

for (const [index, example] of TRADE_ACCEPTANCE_CASES.entries()) {
  test(`analytical acceptance ${index + 1}: ${example.question}`, async () => {
    const result = executeTradeQuery(data, example.expected);
    if (result.operation === "compare") {
      assert.deepEqual([result.left.value, result.right.value, result.difference], expectedRows[index]);
      assert.equal(result.left.complete, true);
      assert.equal(result.right.complete, true);
      if (index === 5) assert.ok(Math.abs(result.percentage - (-18.550322829464214)) < 1e-10);
      if (index === 9) assert.ok(Math.abs(result.percentage - 3.718830637910417) < 1e-10);
    } else {
      assert.deepEqual(result.rows.map(row => [row.key, row.value]), expectedRows[index]);
    }
    const answer = formatTradeResult(result);
    assert.doesNotMatch(answer, /snapshot|facts observed|schemaVersion|NaN|Infinity/);
    assert.doesNotMatch(answer, /\$\d{4,}/, "Every dollar amount has grouping separators");
    const graph = createTradeAgent(data, async request => {
      assert.equal(request, example.question);
      return example.expected;
    }).createGraph().compile();
    const execution = await graph.invoke({ agentExecutionContext: {
      userRequest: example.question, assignedTask: example.question, messages: [], priorSteps: [], sharedState: {},
    } });
    assert.equal(execution.status, "success");
    assert.equal(execution.outputMessage, answer);
  });
}

test("ten-question model evaluator validates meaning, not merely successful execution", async () => {
  const injected = async request => TRADE_ACCEPTANCE_CASES.find(example => example.question === request).expected;
  const reports = await evaluateTradeAcceptance(data, injected);
  assert.equal(reports.length, 10);
  assert.ok(reports.every(report => report.passed));
  const wrongRank = await evaluateTradeAcceptance(data, async (request, ...args) => {
    const expected = await injected(request, ...args);
    return expected.action.operation === "rank" && expected.action.startRank === 2
      ? { ...expected, action: { ...expected.action, startRank: 1 } } : expected;
  });
  assert.equal(wrongRank[1].passed, false, "Highest is not equivalent to second highest, even though both execute");
  assert.equal(wrongRank.filter(report => report.passed).length, 9);
});

test("equivalent period representations and selection ordering match in the model evaluator", async () => {
  const reports = await evaluateTradeAcceptance(data, async request => {
    const example = TRADE_ACCEPTANCE_CASES.find(c => c.question === request);
    if (example.expected.action.operation !== "compare" || example.expected.action.calculation !== "share") return example.expected;
    const action = example.expected.action;
    const period = { type: "months", months: ["202606", "202605", "202604", "202603", "202602", "202601"] };
    return { schemaVersion: 2, action: { ...action, left: { ...action.left, period }, right: { ...action.right, period } } };
  });
  assert.ok(reports.every(report => report.passed));
});

test("structured output converts to a strict object JSON schema with all analytical operations", () => {
  const schema = z.toJSONSchema(tradeQuerySchema);
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  const operations = schema.properties.action.anyOf.map(item => item.properties.operation.const);
  assert.deepEqual(operations, ["aggregate", "rank", "compare", "explain", "clarify"]);
  assert.doesNotMatch(JSON.stringify(schema), /"oneOf"/);
  validateReferences(schema);
});

function validateReferences(node, path = []) {
  if (!node || typeof node !== "object") return;
  if ("$ref" in node) {
    assert.deepEqual(Object.keys(node), ["$ref"],
      `Invalid schema at ${path.join(".")}: $ref cannot have sibling keywords`);
  }
  for (const [key, child] of Object.entries(node)) validateReferences(child, [...path, key]);
}

test("SDK Zod conversion never places title or description beside a schema reference", () => {
  const schema = toJsonSchema(tradeQuerySchema, {
    cycles: "ref", reused: "ref",
    override(ctx) { ctx.jsonSchema.title = "extract"; },
  });
  validateReferences(schema);
});

test("SDK model client's structured-output transport round-trips every plan without external requests", async () => {
  for (const example of TRADE_ACCEPTANCE_CASES) {
    let calls = 0;
    const model = new ChatOpenAI({
      model: "gpt-4o-mini", apiKey: "offline-test", maxRetries: 0,
      configuration: {
        baseURL: "https://offline.invalid/v1",
        fetch: async (url, options) => {
          calls++;
          assert.match(String(url), /^https:\/\/offline\.invalid\//);
          const body = JSON.parse(options.body);
          assert.equal(body.response_format.type, "json_schema");
          const schema = body.response_format.json_schema.schema;
          assert.equal(schema.type, "object");
          assert.equal(schema.properties.action.anyOf.length, 5);
          assert.doesNotMatch(JSON.stringify(schema), /"oneOf"/);
          return new Response(JSON.stringify({
            id: "offline", object: "chat.completion", created: 0, model: "gpt-4o-mini",
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(example.expected) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    });
    const parsed = await model.withStructuredOutput(tradeQuerySchema).invoke(example.question);
    assert.equal(calls, 1);
    assert.deepEqual(parsed, example.expected);
  }
});

test("month sets, ranges, and multi-commodity totals use exact selections without filling unknowns", () => {
  const action = TRADE_ACCEPTANCE_CASES[0].expected.action;
  const result = executeTradeQuery(data, { schemaVersion: 2, action: {
    ...action, selection: { ...action.selection, commodities: ["corn", "soybeans"],
      period: { type: "months", months: ["202601", "202603"] } },
  } });
  const facts = data.records.filter(r => r.partnerCode === "MX" && r.direction === "exports" &&
    ["corn", "soybeans"].includes(r.commodityId) && ["202601", "202603"].includes(r.month));
  assert.equal(result.rows[0].value, facts.reduce((sum, r) => sum + r.valueUsd, 0));
  assert.equal(result.rows[0].expected, 4);
  const answer = formatTradeResult(result);
  assert.match(answer, /January 2026, March 2026/);
  assert.doesNotMatch(answer, /February 2026/);
});
