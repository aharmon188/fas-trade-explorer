// Query contract between any "question understanding" layer (rule parser, Esri custom agent,
// or another LLM) and the explorer. Producers only emit an ExplorerQuery; this module validates it
// against the loaded catalog, applies it to UI state, and computes answers from loaded data.
// No dependencies, so it can be tested in Node and reused by the UI unchanged.

export const SCHEMA_VERSION = 1;
export const CAVEAT = "Unofficial prototype; not for decision making. Commodity groups follow GATS BICO-HS10 lists (membership differs by direction; imports have no Corn or Soybeans group). Exports are domestic exports; imports are general customs value.";

export type Intent = "set_view" | "rank" | "trend" | "explain" | "clarify" | "unsupported";
export type Direction = "exports" | "imports";
export type Metric = "valueUsd" | "quantityMt";
export type Period = { type: "all" } | { type: "month"; month: string };

// A null field means "not specified; keep the current UI value".
export interface ExplorerQuery {
  schemaVersion: 1;
  intent: Intent;
  partner: string | null;
  commodity: string | null;
  direction: Direction | null;
  metric: Metric | null;
  period: Period | null;
  message: string | null;
}

export interface UiState { partner: string; commodity: string; direction: Direction; metric: Metric; period: string }

export interface Catalog {
  partners: { code: string; name: string }[];
  commodities: { id: string; name: string; directions?: Direction[] }[];
  months: string[];
}
export interface FactRow {
  partnerCode: string; commodityId: string; month: string; direction: Direction;
  valueUsd: number | null; quantityMt: number | null;
}
export interface DataForAnswers extends Catalog {
  commodities: { id: string; name: string; description?: string }[];
  records: FactRow[];
}

const INTENTS: Intent[] = ["set_view", "rank", "trend", "explain", "clarify", "unsupported"];
const KEYS = ["schemaVersion", "intent", "partner", "commodity", "direction", "metric", "period", "message"];

export type Validation = { ok: true; query: ExplorerQuery } | { ok: false; errors: string[] };

export function emptyQuery(intent: Intent, message: string | null = null): ExplorerQuery {
  return { schemaVersion: 1, intent, partner: null, commodity: null, direction: null, metric: null, period: null, message };
}

// Strict: anything not in the catalog or the closed vocabularies is rejected, never coerced.
export function validateQuery(raw: unknown, catalog: Catalog): Validation {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["query must be an object"] };
  const q = raw as Record<string, unknown>;
  for (const key of Object.keys(q)) if (!KEYS.includes(key)) errors.push(`unknown field: ${key}`);
  for (const key of KEYS) if (!(key in q)) errors.push(`missing field: ${key}`);
  if (errors.length) return { ok: false, errors };
  if (q.schemaVersion !== SCHEMA_VERSION) errors.push("unsupported schemaVersion");
  if (!INTENTS.includes(q.intent as Intent)) errors.push("invalid intent");
  if (q.partner !== null && !catalog.partners.some(p => p.code === q.partner)) errors.push("partner is not in the catalog");
  if (q.commodity !== null && !catalog.commodities.some(c => c.id === q.commodity)) errors.push("commodity is not in the catalog");
  if (q.direction !== null && q.direction !== "exports" && q.direction !== "imports") errors.push("invalid direction");
  if (q.metric !== null && q.metric !== "valueUsd" && q.metric !== "quantityMt") errors.push("invalid metric");
  const chosen = catalog.commodities.find(c => c.id === q.commodity);
  if (chosen?.directions && (q.direction === "exports" || q.direction === "imports") && !chosen.directions.includes(q.direction)) {
    errors.push(`${chosen.name} has no BICO group for ${q.direction}`);
  }
  const period = q.period as Record<string, unknown> | null;
  if (period !== null) {
    if (typeof period !== "object" || Array.isArray(period)) errors.push("invalid period");
    else if (period.type === "all") { if (Object.keys(period).length !== 1) errors.push("invalid period"); }
    else if (period.type === "month") {
      if (Object.keys(period).length !== 2 || typeof period.month !== "string" || !catalog.months.includes(period.month)) errors.push("period month is not in the available window");
    } else errors.push("invalid period");
  }
  const needsMessage = q.intent === "clarify" || q.intent === "unsupported";
  if (needsMessage && (typeof q.message !== "string" || !q.message.trim() || q.message.length > 300)) errors.push("clarify/unsupported require a message of at most 300 characters");
  if (!needsMessage && q.message !== null) errors.push("message is only allowed for clarify/unsupported");
  return errors.length ? { ok: false, errors } : { ok: true, query: q as unknown as ExplorerQuery };
}

export function applyQuery(state: UiState, query: ExplorerQuery): { state: UiState; changed: string[] } {
  if (query.intent === "clarify" || query.intent === "unsupported") return { state, changed: [] };
  const next: UiState = { ...state };
  if (query.partner) next.partner = query.partner;
  if (query.commodity) next.commodity = query.commodity;
  if (query.direction) next.direction = query.direction;
  if (query.metric) next.metric = query.metric;
  if (query.period) next.period = query.period.type === "all" ? "all" : query.period.month;
  const changed = (Object.keys(next) as (keyof UiState)[]).filter(key => next[key] !== state[key]);
  return { state: next, changed };
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const COMMODITY_ALIASES: Record<string, string[]> = {
  corn: ["corn", "maize"], soybeans: ["soybeans", "soybean", "soy", "soya"], wheat: ["wheat"], rice: ["rice"],
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, word: string) => new RegExp(`\\b${escape(word)}\\b`, "i").test(text);

const monthLabel = (month: string) => `${MONTH_NAMES[Number(month.slice(4)) - 1]} ${month.slice(0, 4)}`;

// Deterministic baseline. It must refuse or ask rather than guess; a model-backed producer is held to the same contract.
export function parseQuestion(question: string, catalog: Catalog): ExplorerQuery {
  const text = question.trim();
  if (!text) return emptyQuery("clarify", "Ask about a partner, commodity, trade direction, or month in the pilot.");

  const partners = catalog.partners.filter(p => mentions(text, p.name));
  const commodities = catalog.commodities.filter(c =>
    (COMMODITY_ALIASES[c.id] ?? [c.name.toLowerCase()]).some(alias => mentions(text, alias)));

  const wantsExports = /\bexport(s|ed|ing)?\b|\bsell(s|ing)?\b|\bsold\b|\bshipp?(ed|ing)? to\b/i.test(text);
  const wantsImports = /\bimport(s|ed|ing)?\b|\bbuy(s|ing)?\b|\bbought\b|\bpurchas(e|ed|es|ing)\b/i.test(text);
  if (wantsExports && wantsImports) return emptyQuery("clarify", "Do you want U.S. exports or U.S. imports? Pick one direction.");

  const wantsQuantity = /\b(tons?|tonnes?|metric|quantity|volume|mt|kg|weight)\b/i.test(text);
  const wantsValue = /\b(value|dollars?|usd|worth|revenue)\b|\$/i.test(text);
  if (wantsQuantity && wantsValue) return emptyQuery("clarify", "Do you want value in USD or quantity in metric tons? Pick one measure.");

  const intent: Intent = /\b(definition|define|mean|means|include|includes|included|caveat|re-?exports?|official|bico)\b/i.test(text) ? "explain"
    : /\b(top|rank|ranking|largest|biggest|highest|most|compare|comparison|which (partner|partners|country|countries))\b/i.test(text) ? "rank"
    : /\b(trend|over time|trajectory|by month|monthly)\b/i.test(text) ? "trend" : "set_view";

  // A named place that is not in the catalog must not be silently ignored.
  const place = /\b(?:to|from|with|in|for)\s+((?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+)*)/.exec(text);
  if (place && !partners.length && !MONTH_NAMES.includes(place[1].toLowerCase().split(" ")[0]) &&
      !catalog.commodities.some(c => (COMMODITY_ALIASES[c.id] ?? [c.name.toLowerCase()]).some(a => a === place[1].toLowerCase()))) {
    return emptyQuery("unsupported", `"${place[1]}" is not in this pilot. Available partners: ${catalog.partners.map(p => p.name).join(", ")}.`);
  }
  if (partners.length > 1 && intent !== "rank") {
    return emptyQuery("clarify", `Which partner: ${partners.map(p => p.name).join(" or ")}? Ask to rank or compare to see all pilot partners.`);
  }
  if (commodities.length > 1) {
    return emptyQuery("clarify", `Which commodity: ${commodities.map(c => c.name).join(" or ")}? One commodity at a time is supported.`);
  }

  let period: Period | null = null;
  const named = MONTH_NAMES.findIndex(name => mentions(text, name) || mentions(text, name.slice(0, 3)) && name !== "may");
  const yearMatch = /\b(20\d{2})\b/.exec(text);
  if (/\b(last|latest|most recent|newest) month\b|\blatest\b/i.test(text)) {
    period = { type: "month", month: catalog.months[catalog.months.length - 1] };
  } else if (named >= 0) {
    const mm = String(named + 1).padStart(2, "0");
    const candidates = catalog.months.filter(m => m.slice(4) === mm && (!yearMatch || m.slice(0, 4) === yearMatch[1]));
    if (candidates.length !== 1) {
      return emptyQuery("unsupported", `${MONTH_NAMES[named]}${yearMatch ? ` ${yearMatch[1]}` : ""} is outside the available window (${monthLabel(catalog.months[0])} to ${monthLabel(catalog.months[catalog.months.length - 1])}).`);
    }
    period = { type: "month", month: candidates[0] };
  } else if (/\b(last|past|previous)\s+\d+\s+months?\b|\byear to date\b|\bytd\b|\bquarter\b/i.test(text)) {
    return emptyQuery("unsupported", "Custom ranges are not supported yet. Ask for one month or the full 12-month window.");
  } else if (/\b(12|twelve) months?\b|\bfull (window|period)\b|\ball months\b|\bwhole year\b/i.test(text)) {
    period = { type: "all" };
  }

  const query: ExplorerQuery = {
    schemaVersion: 1, intent,
    partner: partners.length === 1 ? partners[0].code : null,
    commodity: commodities.length === 1 ? commodities[0].id : null,
    direction: wantsExports ? "exports" : wantsImports ? "imports" : null,
    metric: wantsQuantity ? "quantityMt" : wantsValue ? "valueUsd" : null,
    period, message: null,
  };
  const recognized = query.partner || query.commodity || query.direction || query.metric || query.period || intent !== "set_view";
  return recognized ? query : emptyQuery("clarify", "I couldn't match that to the pilot. Try a partner, commodity, direction (exports/imports), or month.");
}

export interface Ranked { code: string; name: string; value: number | null; observed: number; expected: number; complete: boolean }

function rowsFor(data: DataForAnswers, state: UiState, partner: string) {
  return data.records.filter(r => r.partnerCode === partner && r.commodityId === state.commodity &&
    r.direction === state.direction && (state.period === "all" || r.month === state.period));
}
export function summarize(data: DataForAnswers, state: UiState, partner: string = state.partner): Ranked {
  const rows = rowsFor(data, state, partner);
  const observed = rows.filter(r => r[state.metric] !== null);
  return {
    code: partner, name: data.partners.find(p => p.code === partner)?.name ?? partner,
    value: observed.length ? observed.reduce((sum, r) => sum + (r[state.metric] ?? 0), 0) : null,
    observed: observed.length, expected: rows.length, complete: rows.length > 0 && observed.length === rows.length,
  };
}
// Complete results first, then partial, then unknown; unknown is never ranked as zero.
export function rankPartners(data: DataForAnswers, state: UiState): Ranked[] {
  const tier = (r: Ranked) => r.complete ? 0 : r.value !== null ? 1 : 2;
  return data.partners.map(p => summarize(data, state, p.code))
    .sort((a, b) => tier(a) - tier(b) || (b.value ?? 0) - (a.value ?? 0));
}

const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const amount = (state: UiState, value: number | null) =>
  value === null ? "no reported rows" : state.metric === "valueUsd" ? `$${fmt.format(value)}` : `${fmt.format(value)} MT`;
const where = (state: UiState, name: string) => state.direction === "exports" ? `U.S. exports to ${name}` : `U.S. imports from ${name}`;
const when = (state: UiState) => state.period === "all" ? "over the 12-month window" : `in ${monthLabel(state.period)}`;

// Every number comes from loaded data. A language model may choose the query, never the figures.
export function answerQuery(data: DataForAnswers, state: UiState, query: ExplorerQuery): string[] {
  if (query.intent === "clarify" || query.intent === "unsupported") return [query.message ?? ""];
  const commodity = data.commodities.find(c => c.id === state.commodity);
  const label = commodity?.name ?? state.commodity;
  if (query.intent === "explain") {
    return [`${label}: ${commodity?.description ?? "no definition available"}`, CAVEAT];
  }
  if (query.intent === "rank") {
    const ranked = rankPartners(data, state);
    return [
      `${label}, ${state.direction}, ${when(state)}, among the five selected pilot partners only (not a world ranking):`,
      ...ranked.map((r, i) => `${i + 1}. ${r.name}: ${amount(state, r.value)}${r.complete ? "" : ` (partial: ${r.observed}/${r.expected} months observed)`}`),
      CAVEAT,
    ];
  }
  const s = summarize(data, state);
  const lines = [`${label}: ${where(state, s.name)} ${when(state)}: ${amount(state, s.value)}${s.complete ? "" : ` (partial: ${s.observed}/${s.expected} months observed; missing months are unknown, not zero)`}.`];
  if (query.intent === "trend") {
    for (const month of data.months) {
      const row = summarize(data, { ...state, period: month });
      lines.push(`${monthLabel(month)}: ${amount(state, row.value)}`);
    }
  }
  lines.push(CAVEAT);
  return lines;
}
