import Graphic from "@arcgis/core/Graphic.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import Polyline from "@arcgis/core/geometry/Polyline.js";
import SimpleLineSymbol from "@arcgis/core/symbols/SimpleLineSymbol.js";
import { tradeFlowPath, tradeFlowStyle } from "./trade-flows.ts";
import type { TradeFlow } from "./trade-flows.ts";
import type { Direction } from "./overview-aggregation.ts";

export function createTradeFlowOverlay() {
  return new GraphicsLayer({ id: "trade-flows", title: "Directional trade flows", listMode: "hide" });
}

export function tradeFlowGraphics(
  flows: TradeFlow[], direction: Direction,
  maximum = Math.max(0, ...flows.filter(f => f.complete).map(f => f.value ?? 0)),
): Graphic[] {
  if (!Number.isFinite(maximum) || maximum < 0) throw new Error("Trade flow maximum must be nonnegative and finite.");
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  return flows.filter(flow => flow.value !== 0 || !flow.complete)
    .sort((a, b) => (a.value ?? 0) - (b.value ?? 0))
    .map(flow => {
      const style = tradeFlowStyle(flow, maximum, direction);
      return new Graphic({
        geometry: new Polyline({ paths: [tradeFlowPath(flow.origin, flow.destination)], spatialReference: { wkid: 3857 } }),
        symbol: new SimpleLineSymbol({
          color: style.color, width: style.width, style: style.dashed ? "dash" : "solid",
          cap: "round", marker: { style: "arrow", placement: "end" },
        }),
        attributes: {
          flowId: flow.id, partnerCode: flow.region ? null : flow.id, region: flow.region,
          name: flow.name, valueUsd: flow.value,
          routeLabel: direction === "exports" ? `U.S. to ${flow.name}` : `${flow.name} to U.S.`,
          valueLabel: flow.value === null ? "No reported value" : `${usd.format(flow.value)}${flow.complete ? "" : " (partial observed total)"}`,
          coverageLabel: flow.region
            ? "Selected European partners only; click to expand. Not all European trade."
            : "Click to select this partner.",
        },
        popupTemplate: {
          title: "{routeLabel}",
          content: "{valueLabel}<br>{coverageLabel}<br>Illustrative connection, not a shipping route.",
        },
      });
    });
}
