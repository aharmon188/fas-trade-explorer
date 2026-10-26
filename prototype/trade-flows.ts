import type { Aggregate, Direction } from "./overview-aggregation.ts";

type Coordinate = [number, number];
export const US_TRADE_HUB: Coordinate = [-98, 39];
export const EUROPE_FLOW_SCALE = 50_000_000;
const EUROPE_HUB: Coordinate = [9, 50];

// Approximate display anchors, not ports, shipping routes, or official centroids.
const ANCHORS: Record<string, Coordinate> = {
  CA: [-106, 56], MX: [-102, 24], BR: [-52, -14], JA: [138, 36], CH: [104, 35],
  KS: [128, 36], TW: [121, 24], VM: [108, 16], IN: [79, 22], ID: [118, -3],
  TH: [101, 15], A2: [134, -25], UK: [-2, 54], GM: [10, 51], NL: [5, 52],
  F1: [2, 46], I1: [12, 43], SP: [-4, 40], CO: [-74, 4], CI: [-71, -30],
};
const EUROPE = new Set(["UK", "GM", "NL", "F1", "I1", "SP"]);
export interface PartnerTrade extends Aggregate { code: string; name: string }
export interface TradeFlow extends Aggregate {
  id: string;
  name: string;
  partnerCodes: string[];
  region: boolean;
  origin: Coordinate;
  destination: Coordinate;
}
export interface FlowStyle { width: number; color: [number, number, number, number]; dashed: boolean }

export function monthlyFlowMaximum(
  months: PartnerTrade[][], direction: Direction, scale: number, selectedPartner = "all",
): number {
  return Math.max(0, ...months.flatMap(partners =>
    buildTradeFlows(partners, direction, scale, selectedPartner)
      .filter(flow => flow.complete).map(flow => flow.value ?? 0)));
}

export function buildTradeFlows(
  partners: PartnerTrade[], direction: Direction, scale: number, selectedPartner = "all",
): TradeFlow[] {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Trade flow scale must be positive and finite.");
  if (new Set(partners.map(p => p.code)).size !== partners.length) throw new Error("Duplicate partner in trade flows.");
  if (selectedPartner !== "all" && !partners.some(p => p.code === selectedPartner)) {
    throw new Error("Selected flow partner is outside the loaded coverage.");
  }
  for (const partner of partners) {
    if (!ANCHORS[partner.code]) throw new Error(`No trade flow display anchor for ${partner.name}.`);
    if (partner.value !== null && (!Number.isFinite(partner.value) || partner.value < 0)) {
      throw new Error(`Invalid trade flow value for ${partner.name}.`);
    }
  }
  const selected = selectedPartner === "all" ? partners : partners.filter(p => p.code === selectedPartner);
  const grouped = direction === "exports" && selectedPartner === "all" && scale >= EUROPE_FLOW_SCALE;
  const europe = grouped ? selected.filter(p => EUROPE.has(p.code)) : [];
  const makeFlow = (id: string, name: string, members: PartnerTrade[], anchor: Coordinate, region: boolean): TradeFlow => {
    const values = members.flatMap(p => p.value === null ? [] : [p.value]);
    const observed = members.reduce((sum, p) => sum + p.observed, 0);
    const expected = members.reduce((sum, p) => sum + p.expected, 0);
    return {
      id, name, partnerCodes: members.map(p => p.code), region,
      value: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      observed, expected, complete: members.every(p => p.complete),
      origin: direction === "exports" ? [...US_TRADE_HUB] : [...anchor],
      destination: direction === "exports" ? [...anchor] : [...US_TRADE_HUB],
    };
  };
  const flows = selected.filter(p => europe.length < 2 || !EUROPE.has(p.code))
    .map(p => makeFlow(p.code, p.name, [p], ANCHORS[p.code], false));
  if (europe.length >= 2) flows.push(makeFlow("europe", `Europe (${europe.length} selected partners)`, europe, EUROPE_HUB, true));
  return flows;
}

export function tradeFlowStyle(flow: Aggregate, maximum: number, direction: Direction): FlowStyle {
  if (!flow.complete || flow.value === null) return { width: 1.2, color: [145, 157, 173, 0.65], dashed: true };
  const weight = maximum > 0 ? Math.sqrt(Math.min(1, flow.value / maximum)) : 0;
  const low = direction === "exports" ? [39, 88, 83] : [109, 72, 39];
  const high = direction === "exports" ? [119, 246, 201] : [255, 200, 111];
  return {
    width: 0.9 + 3.1 * weight,
    color: [
      Math.round(low[0] + (high[0] - low[0]) * weight),
      Math.round(low[1] + (high[1] - low[1]) * weight),
      Math.round(low[2] + (high[2] - low[2]) * weight),
      0.5 + 0.5 * weight,
    ],
    dashed: false,
  };
}

/** An illustrative curved path in Web Mercator, using the short crossing of the dateline. */
export function tradeFlowPath(origin: Coordinate, destination: Coordinate): number[][] {
  const radius = 6378137;
  const project = ([longitude, latitude]: Coordinate): Coordinate =>
    [radius * longitude * Math.PI / 180, radius * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360))];
  const from = project(origin);
  let longitude = destination[0];
  while (longitude - origin[0] > 180) longitude -= 360;
  while (longitude - origin[0] < -180) longitude += 360;
  const to = project([longitude, destination[1]]);
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const control: Coordinate = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 + distance * 0.24];
  return Array.from({ length: 49 }, (_, i) => {
    const t = i / 48;
    return [
      (1 - t) ** 2 * from[0] + 2 * (1 - t) * t * control[0] + t ** 2 * to[0],
      (1 - t) ** 2 * from[1] + 2 * (1 - t) * t * control[1] + t ** 2 * to[1],
    ];
  });
}
