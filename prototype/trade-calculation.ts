import { z } from "zod";
import { aggregateFacts, commodityFactIds } from "./overview-aggregation.ts";
import type { Aggregate, CommodityOption, Fact } from "./overview-aggregation.ts";

export interface TradeData {
  version: string;
  selectionBasis?: string;
  months: string[];
  partners: { code: string; name: string }[];
  commodities: (CommodityOption & {
    name: string; description: string; category: string;
    groups?: Partial<Record<"exports" | "imports", { category: string }>>;
  })[];
  records: Fact[];
}

// Separate instances prevent SDK conversion from adding descriptions beside shared $refs.
const idsSchema = () => z.union([z.literal("all"), z.array(z.string()).min(1)]);
const periodSchema = z.union([
  z.object({ type: z.literal("full_window") }).strict(),
  z.object({ type: z.literal("months"), months: z.array(z.string()).min(1) }).strict(),
  z.object({ type: z.literal("range"), from: z.string(), to: z.string() }).strict(),
]);
const selectionSchema = z.object({
  partners: idsSchema().describe("Covered partner IDs, or all."),
  commodities: idsSchema().describe("Commodity IDs, or all. Never combine overlapping category rollups and groups."),
  direction: z.enum(["exports", "imports"]),
  period: periodSchema,
}).strict();
const groupSchema = z.enum(["none", "partner", "commodity", "month"]);
export const tradeQuerySchema = z.object({
  schemaVersion: z.literal(2),
  action: z.union([
    z.object({ operation: z.literal("aggregate"), selection: selectionSchema, groupBy: groupSchema }).strict(),
    z.object({
      operation: z.literal("rank"), selection: selectionSchema,
      groupBy: z.enum(["partner", "commodity", "month"]),
      order: z.enum(["descending", "ascending"]),
      startRank: z.number().int().min(1),
      count: z.number().int().min(1).max(100),
    }).strict(),
    z.object({
      operation: z.literal("compare"), left: selectionSchema, right: selectionSchema,
      calculation: z.enum(["values", "difference", "change", "ratio", "share"])
        .describe("change: right vs left baseline; share: left numerator / right denominator * 100."),
    }).strict(),
    z.object({ operation: z.literal("explain"), selection: selectionSchema }).strict(),
    z.object({ operation: z.literal("clarify"), message: z.string().min(1).max(500) }).strict(),
  ]),
}).strict();

export type TradeQuery = z.infer<typeof tradeQuerySchema>;
export type Selection = z.infer<typeof selectionSchema>;
type GroupBy = z.infer<typeof groupSchema>;
type DataCommodity = TradeData["commodities"][number];
interface ResolvedSelection {
  partners: string[];
  commodities: string[];
  months: string[];
  direction: Selection["direction"];
}
export interface TradeRow extends Aggregate { key: string; label: string; rank?: number }
interface ResultBase { query: TradeQuery; datasetVersion: string }
export type TradeResult = ResultBase & (
  | { operation: "clarify"; message: string }
  | { operation: "explain"; message: string }
  | {
    operation: "aggregate" | "rank"; rows: TradeRow[]; subject: string;
    groupBy: GroupBy; incomplete: boolean; unknown: number; shortfall: boolean;
  }
  | {
    operation: "compare"; left: TradeRow; right: TradeRow;
    calculation: "values" | "difference" | "change" | "ratio" | "share";
    difference: number | null; percentage: number | null; ratio: number | null;
    reason: string | null;
  }
);

export const TRADE_SEMANTICS = `Each fact is one partner x commodity x direction x month.
USD values describe individual months. Always SUM the selected months before comparing or ranking.
Never use the maximum monthly fact as a period total.
New questions default to all covered partners, all commodities, exports, full_window; values are USD only.
Exports mean U.S. domestic exports TO a partner; imports mean U.S. general imports FROM a partner.
All commodities totals use disjoint category rollups ONLY, never rollups plus their groups.
Grouping by commodity with commodities=all enumerates constituent GROUPS ONLY, never category rollups.
Missing/null facts are unknown, not zero. Rankings sort observed sums numerically, never completeness-first.
Ranks are dense: ties share a rank; the next distinct value gets the next rank. Include all ties.
Rankings cover only the loaded partners/commodities/months, not the world.
Compare change uses left as the baseline and right as the new value.
Share uses left as numerator and right as denominator; the numerator must be a subset of the denominator.
No change/ratio/share is claimed for incomplete values or a zero denominator.
Never silently substitute direction-specific commodity definitions. Imports have no Corn or Soybeans group.
Quantities, forecasts, unavailable years/partners, unrestricted SQL, and arbitrary code are not supported.`;

export function tradeCatalog(data: TradeData) {
  return {
    partners: data.partners,
    commodities: data.commodities.map(c => ({
      id: c.id, name: c.name, kind: c.kind, directions: c.directions,
      categories: Object.fromEntries(c.directions.map(d => [d, categoryOf(c, d)])),
    })),
    months: data.months,
    selectionBasis: data.selectionBasis ?? "Selected partner coverage, not a worldwide ranking.",
  };
}

function categoryOf(commodity: DataCommodity, direction: Selection["direction"]): string {
  return commodity.groups?.[direction]?.category ?? commodity.category;
}
function requireUnique(values: string[], description: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${description} in selection.`);
}
function resolveSelection(data: TradeData, selection: Selection, groupBy: GroupBy = "none"): ResolvedSelection {
  const partners = selection.partners === "all" ? data.partners.map(p => p.code) : selection.partners;
  requireUnique(partners, "partners");
  if (partners.some(code => !data.partners.some(p => p.code === code))) throw new Error("Partner is outside the loaded coverage.");
  let months: string[];
  if (selection.period.type === "full_window") months = data.months;
  else if (selection.period.type === "months") months = selection.period.months;
  else {
    const { from, to } = selection.period;
    if (!data.months.includes(from) || !data.months.includes(to) || from > to) {
      throw new Error("Period range is outside the loaded window or reversed.");
    }
    months = data.months.filter(month => month >= from && month <= to);
  }
  requireUnique(months, "months");
  if (!months.length || months.some(month => !data.months.includes(month))) throw new Error("Month is outside the loaded window.");
  months = [...months].sort();
  const direction = selection.direction;
  let commodities: string[];
  if (selection.commodities === "all") {
    commodities = groupBy === "commodity"
      ? data.commodities.filter(c => c.kind === "group" && c.directions.includes(direction)).map(c => c.id)
      : commodityFactIds(data.commodities, direction, "all");
  } else {
    requireUnique(selection.commodities, "commodities");
    commodities = selection.commodities.flatMap(id => commodityFactIds(data.commodities, direction, id));
    const selected = data.commodities.filter(c => commodities.includes(c.id));
    const rollups = selected.filter(c => c.kind === "category");
    if (selected.some(c => c.kind === "group" && rollups.some(r => categoryOf(r, direction) === categoryOf(c, direction)))) {
      throw new Error("Commodity selection overlaps a category rollup and a constituent group. Select disjoint commodities.");
    }
    if (groupBy === "commodity" && new Set(selected.map(c => c.kind)).size > 1) {
      throw new Error("Do not rank or group category rollups together with constituent groups.");
    }
  }
  if (!partners.length || !commodities.length) throw new Error("The selection contains no covered partners or commodities.");
  return { partners, commodities, months, direction };
}

const dateLabel = (month: string) => new Date(`${month.slice(0, 4)}-${month.slice(4)}-01T12:00:00Z`)
  .toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
function periodLabel(data: TradeData, selection: ResolvedSelection): string {
  if (selection.months.length === data.months.length) return "";
  const indexes = selection.months.map(month => data.months.indexOf(month));
  if (indexes.length > 1 && indexes.every((index, i) => i === 0 || index === indexes[i - 1] + 1)) {
    return ` from ${dateLabel(selection.months[0])} through ${dateLabel(selection.months.at(-1)!)}`;
  }
  return ` in ${selection.months.map(dateLabel).join(", ")}`;
}
function commodityLabel(data: TradeData, selection: Selection): string {
  return selection.commodities === "all" ? "all covered commodity"
    : selection.commodities.map(id => data.commodities.find(c => c.id === id)!.name.toLowerCase()).join(" and ");
}
function subject(data: TradeData, original: Selection, resolved: ResolvedSelection): string {
  return `value of ${commodityLabel(data, original)} ${original.direction}${periodLabel(data, resolved)}`;
}
function partnerLabel(data: TradeData, resolved: ResolvedSelection): string {
  return `${resolved.direction === "exports" ? "to" : "from"} ${resolved.partners.length === data.partners.length
    ? "all covered partners" : resolved.partners.map(code => data.partners.find(p => p.code === code)!.name).join(" and ")}`;
}
function total(data: TradeData, selection: ResolvedSelection, key: string, label: string): TradeRow {
  return { key, label, ...aggregateFacts(data.records, selection.partners, selection.commodities, selection.direction, selection.months) };
}
function aggregateRows(data: TradeData, original: Selection, selection: ResolvedSelection, groupBy: GroupBy): TradeRow[] {
  if (groupBy === "none") {
    return [total(data, selection, "total",
      `${commodityLabel(data, original)} ${original.direction} ${partnerLabel(data, selection)}${periodLabel(data, selection)}`)];
  }
  if (groupBy === "partner") return selection.partners.map(code =>
    total(data, { ...selection, partners: [code] }, code, data.partners.find(p => p.code === code)!.name));
  if (groupBy === "commodity") return selection.commodities.map(id =>
    total(data, { ...selection, commodities: [id] }, id, data.commodities.find(c => c.id === id)!.name));
  return selection.months.map(month => total(data, { ...selection, months: [month] }, month, dateLabel(month)));
}
function leafCommodityIds(data: TradeData, selection: ResolvedSelection): Set<string> {
  return new Set(data.commodities.filter(c => c.kind === "group" && c.directions.includes(selection.direction) &&
    selection.commodities.some(id => {
      const selected = data.commodities.find(item => item.id === id)!;
      return selected.id === c.id || selected.kind === "category" && categoryOf(selected, selection.direction) === categoryOf(c, selection.direction);
    })).map(c => c.id));
}

export function executeTradeQuery(data: TradeData, rawQuery: unknown): TradeResult {
  const query = tradeQuerySchema.parse(rawQuery);
  const action = query.action;
  const base = { query, datasetVersion: data.version };
  if (action.operation === "clarify") return { ...base, operation: "clarify", message: action.message };
  if (action.operation === "compare") {
    const a = resolveSelection(data, action.left);
    const b = resolveSelection(data, action.right);
    if (action.calculation === "share") {
      const denominator = leafCommodityIds(data, b);
      if (a.direction !== b.direction || a.partners.some(id => !b.partners.includes(id)) ||
          a.months.some(month => !b.months.includes(month)) ||
          [...leafCommodityIds(data, a)].some(id => !denominator.has(id))) {
        throw new Error("A share requires the numerator to be a subset of the denominator, with the same trade direction.");
      }
    }
    const left = aggregateRows(data, action.left, a, "none")[0];
    const right = aggregateRows(data, action.right, b, "none")[0];
    const complete = left.complete && right.complete && left.value !== null && right.value !== null;
    const difference = complete ? right.value! - left.value! : null;
    const denominator = action.calculation === "share" || action.calculation === "ratio" ? right.value : left.value;
    const ratio = complete && right.value !== 0 ? left.value! / right.value! : null;
    const percentage = action.calculation === "share" ? (ratio === null ? null : ratio * 100)
      : complete && left.value !== 0 ? difference! / left.value! * 100 : null;
    const reason = !complete ? "A reliable comparison is unavailable because one or both values are missing or incomplete."
      : denominator === 0 && ["change", "ratio", "share"].includes(action.calculation)
        ? "A percentage or ratio is undefined because the baseline or denominator is zero." : null;
    return { ...base, operation: "compare", left, right, calculation: action.calculation, difference, percentage, ratio, reason };
  }
  const groupBy = action.operation === "explain" ? "none" : action.groupBy;
  const resolved = resolveSelection(data, action.selection, groupBy);
  if (action.operation === "explain") {
    return { ...base, operation: "explain", message: action.selection.commodities === "all"
      ? "All covered commodities uses disjoint BICO category rollups; constituent groups are not counted again."
      : action.selection.commodities.map(id => data.commodities.find(c => c.id === id)!.description).join("\n\n") };
  }
  let rows = aggregateRows(data, action.selection, resolved, groupBy);
  const incomplete = rows.some(row => !row.complete);
  const unknown = rows.filter(row => row.value === null).length;
  let shortfall = false;
  if (action.operation === "rank") {
    rows = rows.filter(row => row.value !== null).sort((a, b) =>
      (action.order === "descending" ? b.value! - a.value! : a.value! - b.value!) || a.label.localeCompare(b.label));
    let rank = 0;
    let previous: number | null = null;
    rows = rows.map(row => {
      if (row.value !== previous) rank++;
      previous = row.value;
      return { ...row, rank };
    });
    shortfall = rank < action.startRank + action.count - 1;
    rows = rows.filter(row => row.rank! >= action.startRank && row.rank! < action.startRank + action.count);
  }
  const scope = groupBy === "month" || groupBy === "commodity" ? ` ${partnerLabel(data, resolved)}` : "";
  return { ...base, operation: action.operation, rows, subject: `${subject(data, action.selection, resolved)}${scope}`, groupBy, incomplete, unknown, shortfall };
}

function ordinal(rank: number): string {
  if (rank === 1) return "";
  const words: Record<number, string> = { 2: "second-", 3: "third-", 4: "fourth-", 5: "fifth-" };
  return words[rank] ?? `${rank}${rank % 100 >= 11 && rank % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[rank % 10] ?? "th")}-`;
}
function amount(row: TradeRow): string {
  return row.value === null ? "No reported value" : `${usd.format(row.value)}${row.complete ? "" : " (partial total)"}`;
}
export function formatTradeResult(result: TradeResult): string {
  if (result.operation === "clarify" || result.operation === "explain") return result.message;
  if (result.operation === "compare") {
    const values = `${result.left.label}: ${amount(result.left)}; ${result.right.label}: ${amount(result.right)}.`;
    if (result.reason) return `${values} ${result.reason}`;
    if (result.calculation === "values") return values;
    if (result.calculation === "share") return `${result.left.label} accounts for ${number.format(result.percentage!)}% of ${result.right.label}.`;
    if (result.calculation === "ratio") return `${result.left.label} is ${number.format(result.ratio!)} times ${result.right.label}.`;
    if (result.calculation === "change") {
      const movement = result.difference! < 0 ? "decreased" : result.difference! > 0 ? "increased" : "was unchanged";
      return `${values} The value ${movement}${result.difference === 0 ? "" : ` by ${usd.format(Math.abs(result.difference!))} (${number.format(Math.abs(result.percentage!))}%)`}.`;
    }
    return `${values} ${result.difference === 0 ? "The values are equal." : `${result.difference! > 0 ? "The second" : "The first"} value is ${usd.format(Math.abs(result.difference!))} higher.`}`;
  }
  const action = result.query.action;
  const warning = result.incomplete ? " Coverage is incomplete; these are observed values, so rankings or totals may change with missing data." : "";
  if (!result.rows.length) return `No reported value is available${result.operation === "rank" ? " at the requested rank" : ""} for ${result.subject}.${warning}`;
  if (action.operation === "rank" && action.count === 1) {
    const names = result.rows.map(row => row.label).join(" and ");
    const rankLabel = `${ordinal(action.startRank)}${action.order === "descending" ? "highest" : "lowest"}`;
    const verb = result.rows.length > 1 ? "are tied for the" : result.groupBy === "partner" ? "is the partner with the" : "has the";
    return `${names} ${verb} ${rankLabel} ${result.subject}, at ${amount(result.rows[0])}.${warning}`;
  }
  const lines = result.rows.map(row => `${row.rank === undefined ? "" : `${row.rank}. `}${row.label}: ${amount(row)}`);
  return `${result.groupBy === "none" ? "" : `${result.subject}:\n`}${lines.join("\n")}.${warning}${result.shortfall ? " Fewer distinct ranks are available than requested." : ""}`;
}

export function calculateTradeAnswer(data: TradeData, rawQuery: unknown): string {
  return formatTradeResult(executeTradeQuery(data, rawQuery));
}
