export type Direction = "exports" | "imports";

export interface CommodityOption {
  id: string;
  kind: "group" | "category";
  directions: Direction[];
}

export interface Fact {
  partnerCode: string;
  commodityId: string;
  month: string;
  direction: Direction;
  valueUsd: number | null;
}

export interface Aggregate {
  value: number | null;
  observed: number;
  expected: number;
  complete: boolean;
}

export function commodityFactIds(
  commodities: CommodityOption[],
  direction: Direction,
  selectedCommodityId: string,
): string[] {
  if (selectedCommodityId !== "all") {
    const selected = commodities.find(commodity => commodity.id === selectedCommodityId);
    if (!selected || !selected.directions.includes(direction)) {
      throw new Error(`No commodity facts are available for ${selectedCommodityId}/${direction}.`);
    }
    return [selected.id];
  }

  const categories = commodities
    .filter(commodity => commodity.kind === "category" && commodity.directions.includes(direction))
    .map(commodity => commodity.id);
  if (!categories.length) throw new Error(`No category rollups are available for ${direction}.`);
  return categories;
}

export function aggregateFacts(
  records: Fact[],
  partnerCodes: string[],
  commodityIds: string[],
  direction: Direction,
  months: string[],
): Aggregate {
  if (!partnerCodes.length || !commodityIds.length || !months.length) {
    return { value: null, observed: 0, expected: 0, complete: false };
  }
  if (new Set(partnerCodes).size !== partnerCodes.length ||
      new Set(commodityIds).size !== commodityIds.length ||
      new Set(months).size !== months.length) {
    throw new Error("Aggregation selections must contain unique partners, commodities, and months.");
  }

  const partners = new Set(partnerCodes);
  const selectedCommodities = new Set(commodityIds);
  const selectedMonths = new Set(months);
  const selected = records.filter(record =>
    partners.has(record.partnerCode) && selectedCommodities.has(record.commodityId) &&
    record.direction === direction && selectedMonths.has(record.month));
  const keys = new Set<string>();
  for (const record of selected) {
    const key = `${record.partnerCode}/${record.commodityId}/${record.direction}/${record.month}`;
    if (keys.has(key)) throw new Error(`Duplicate fact in aggregation: ${key}`);
    keys.add(key);
  }

  const observedValues = selected.flatMap(record => record.valueUsd === null ? [] : [record.valueUsd]);
  const expected = partnerCodes.length * commodityIds.length * months.length;
  const observed = observedValues.length;
  return {
    value: observed ? observedValues.reduce((sum, value) => sum + value, 0) : null,
    observed,
    expected,
    complete: observed === expected,
  };
}
