import { executeTradeQuery, formatTradeResult } from "./trade-calculation.ts";
import type { Selection, TradeData, TradeQuery, TradeResult } from "./trade-calculation.ts";
import { interpretTradeRequest } from "./trade-agent.ts";
import type { QueryProducer } from "./trade-agent.ts";

const select = (patch: Partial<Selection> = {}): Selection => ({
  partners: "all", commodities: ["wheat"], direction: "exports", period: { type: "full_window" }, ...patch,
});
const query = (action: TradeQuery["action"]): TradeQuery => ({ schemaVersion: 2, action });
export const TRADE_ACCEPTANCE_CASES: { question: string; expected: TradeQuery }[] = [
  {
    question: "What is the total value of wheat exports to Mexico over the loaded reporting window?",
    expected: query({ operation: "aggregate", selection: select({ partners: ["MX"] }), groupBy: "none" }),
  },
  {
    question: "Which covered partner has the second highest wheat export value?",
    expected: query({ operation: "rank", selection: select(), groupBy: "partner", order: "descending", startRank: 2, count: 1 }),
  },
  {
    question: "What are the top three individual export commodity groups to Canada by value?",
    expected: query({ operation: "rank", selection: select({ partners: ["CA"], commodities: "all" }), groupBy: "commodity", order: "descending", startRank: 1, count: 3 }),
  },
  {
    question: "What was the value of wheat imports from Canada in March 2026?",
    expected: query({ operation: "aggregate", selection: select({ partners: ["CA"], direction: "imports", period: { type: "months", months: ["202603"] } }), groupBy: "none" }),
  },
  {
    question: "Compare wheat export values to Mexico and Canada. Which is larger and by how many dollars?",
    expected: query({ operation: "compare", calculation: "difference", left: select({ partners: ["MX"] }), right: select({ partners: ["CA"] }) }),
  },
  {
    question: "How did wheat exports to Canada change from March 2026 to April 2026, in dollars and percent?",
    expected: query({ operation: "compare", calculation: "change",
      left: select({ partners: ["CA"], period: { type: "months", months: ["202603"] } }),
      right: select({ partners: ["CA"], period: { type: "months", months: ["202604"] } }) }),
  },
  {
    question: "Compare the value of corn exports and soybean exports to Japan.",
    expected: query({ operation: "compare", calculation: "values",
      left: select({ partners: ["JA"], commodities: ["corn"] }), right: select({ partners: ["JA"], commodities: ["soybeans"] }) }),
  },
  {
    question: "Compare all covered commodity exports to Canada with imports from Canada. Which value is larger and by how much?",
    expected: query({ operation: "compare", calculation: "difference",
      left: select({ partners: ["CA"], commodities: "all" }),
      right: select({ partners: ["CA"], commodities: "all", direction: "imports" }) }),
  },
  {
    question: "In which month was the value of wheat exports to Mexico highest?",
    expected: query({ operation: "rank", selection: select({ partners: ["MX"] }), groupBy: "month", order: "descending", startRank: 1, count: 1 }),
  },
  {
    question: "What share of all covered commodity exports to Mexico was wheat from January through June 2026?",
    expected: query({ operation: "compare", calculation: "share",
      left: select({ partners: ["MX"], period: { type: "range", from: "202601", to: "202606" } }),
      right: select({ partners: ["MX"], commodities: "all", period: { type: "range", from: "202601", to: "202606" } }) }),
  },
];

function canonicalSelection(data: TradeData, selection: Selection) {
  const months = selection.period.type === "full_window" ? data.months
    : selection.period.type === "months" ? selection.period.months
      : data.months.filter(month => selection.period.type === "range" && month >= selection.period.from && month <= selection.period.to);
  return {
    partners: [...(selection.partners === "all" ? data.partners.map(p => p.code) : selection.partners)].sort(),
    commodities: selection.commodities === "all" ? "all" : [...selection.commodities].sort(),
    direction: selection.direction,
    months: [...months].sort(),
  };
}
function canonicalAction(data: TradeData, action: TradeQuery["action"]) {
  if (action.operation === "clarify") return action;
  if (action.operation === "compare") return {
    operation: action.operation, calculation: action.calculation,
    left: canonicalSelection(data, action.left), right: canonicalSelection(data, action.right),
  };
  const common = { operation: action.operation, selection: canonicalSelection(data, action.selection) };
  if (action.operation === "explain") return common;
  if (action.operation === "aggregate") return { ...common, groupBy: action.groupBy };
  return { ...common, groupBy: action.groupBy, order: action.order, startRank: action.startRank, count: action.count };
}
export interface TradeAcceptanceReport {
  question: string;
  passed: boolean;
  expected: TradeQuery;
  actual: TradeQuery;
  answer: string;
  result: TradeResult;
}

// Run from a signed-in external browser to test the real model, not just injected plans.
export async function evaluateTradeAcceptance(data: TradeData, producer?: QueryProducer): Promise<TradeAcceptanceReport[]> {
  const interpret: QueryProducer = producer ?? ((request, context, config) => interpretTradeRequest(data, request, context, config));
  const reports: TradeAcceptanceReport[] = [];
  for (const example of TRADE_ACCEPTANCE_CASES) {
    const context = { userRequest: example.question, assignedTask: example.question, messages: [], priorSteps: [], sharedState: {} };
    const raw = await interpret(example.question, context);
    const result = executeTradeQuery(data, raw);
    const passed = JSON.stringify(canonicalAction(data, result.query.action)) === JSON.stringify(canonicalAction(data, example.expected.action));
    reports.push({ question: example.question, passed, expected: example.expected, actual: result.query, answer: formatTradeResult(result), result });
  }
  return reports;
}
