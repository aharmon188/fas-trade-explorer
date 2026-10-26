import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import GeoJSONLayer from "@arcgis/core/layers/GeoJSONLayer";
import Graphic from "@arcgis/core/Graphic";
import { watch } from "@arcgis/core/core/reactiveUtils";
import type GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import { createCountryOverlay } from "./country-overlay";
import { createTradeFlowOverlay, tradeFlowGraphics } from "./trade-flow-overlay";
import { buildTradeFlows, monthlyFlowMaximum, EUROPE_FLOW_SCALE } from "./trade-flows";
import type { PartnerTrade } from "./trade-flows";
import { aggregateFacts, commodityFactIds } from "./overview-aggregation";
import { installAssistantPresentation } from "./assistant-presentation";
import { initializeMapViewpoint, SIGNIN_VIEWPOINT_KEY } from "./map-presentation";
import { createTradeAgent } from "./trade-agent";
import SimpleFillSymbol from "@arcgis/core/symbols/SimpleFillSymbol";
import esriId from "@arcgis/core/identity/IdentityManager";
import OAuthInfo from "@arcgis/core/identity/OAuthInfo";
import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/ai-components/components/arcgis-assistant";
import "@arcgis/ai-components/components/arcgis-assistant-agent";
import "@arcgis/ai-components/components/arcgis-assistant-help-agent";
import "@esri/calcite-components/main.css";
import "./style.css";

type Direction = "exports" | "imports";
interface Fact {
  partnerCode: string;
  commodityId: string;
  mappingVersion: string;
  month: string;
  direction: Direction;
  valueUsd: number | null;
  quantityMt: number | null;
  status: "observed" | "no_reported_rows";
  bicoCode?: string;
  includedCount: number;
  sourceUrl: string;
}
interface Partner { code: string; name: string; iso: string }
interface CommodityGroup { bicoCode: string; bicoName: string; category: string; memberCount: number; description: string }
interface Commodity {
  id: string; name: string; kind: "group" | "category"; category: string;
  directions: Direction[]; groups: Partial<Record<Direction, CommodityGroup>>; description: string;
}
interface Dataset {
  partners: Partner[];
  commodities: Commodity[];
  mappingVersion: string;
  months: string[];
  retrievedUtc: string;
  generatedUtc: string;
  version: string;
  selectionBasis?: string;
  assumptions: string[];
  records: Fact[];
}
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="shell">
  <header class="topbar"><div class="brand"><span class="eyebrow">USDA FAS / EXPLORATION LAB</span><h1>Trade, in perspective.</h1></div>
    <p id="subtitle"></p>
    <span class="unofficial">Unofficial prototype · not for decision making</span>
    <button id="about" type="button">Methodology &amp; limits</button>
    <strong class="badge">LOCAL PILOT</strong></header>
  <p id="error" role="alert" hidden></p>
  <section class="filters" aria-label="Filters">
    <label>Exploration mode<select id="mode"><option value="commodity">Commodity → countries</option><option value="country">Country → commodities</option></select></label>
    <label>Partner<select id="partner"></select></label>
    <label>Commodity<select id="commodity"></select></label>
    <label>Trade direction<select id="direction"><option value="exports">U.S. exports to partner</option><option value="imports">U.S. imports from partner</option></select></label>
    <label>Period<select id="period"><option value="all">Full 12-month window</option></select></label>
    <details class="menu"><summary>Download</summary>
      <div><button id="download" type="button">Selected facts CSV</button><button id="download-ranking" type="button">Ranking CSV</button></div></details>
  </section>
  <section class="timeline" aria-label="Trade timeline">
    <button id="timeline-play" type="button" aria-pressed="false" disabled>Play</button>
    <label for="timeline-month">Trade month</label>
    <input id="timeline-month" type="range" min="0" max="12" value="0" step="1" disabled aria-describedby="timeline-help">
    <output id="timeline-label" for="timeline-month">All 12 months</output>
    <button id="timeline-all" type="button" disabled>All 12 months</button>
    <span id="timeline-help">Monthly values, not cumulative · 1.2 seconds/month</span>
  </section>
  <main class="workspace">
    <section class="map-stage">
      <arcgis-map id="map"></arcgis-map>
      <div class="summary overlay"><span class="eyebrow" id="selection"></span><h2 id="total"></h2><p id="coverage"></p><p id="completeness"></p><p id="change"></p></div>
      <div class="legend overlay"><strong id="map-title">Pilot partner comparison</strong><p id="legend"></p>
        <p id="map-status" role="status">Loading country outlines and trade arrows…</p>
        <p>Arrows show illustrative trade connections, not shipping routes. Natural Earth display boundaries are generalized, not authoritative.</p></div>
      <div class="drawer" id="drawer" hidden>
        <section id="panel-trend" role="tabpanel" aria-labelledby="tab-trend" hidden>
          <div class="section-head"><h2 id="trend-title">Monthly trajectory</h2><span id="chart-unit"></span></div>
          <div class="trend-grid"><div><div id="bars" class="bars"></div><p class="caption">Select a month to update the map and comparison.</p></div>
            <div class="table-scroll"><h3 id="table-title">Reported monthly observations</h3>
              <table><thead><tr><th>Month</th><th>Reported USD</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table></div></div>
        </section>
        <section id="panel-compare" role="tabpanel" aria-labelledby="tab-compare" hidden>
          <div class="section-head"><h2>Comparison: selected pilot partners only</h2></div>
          <p class="caption">Not a worldwide ranking and not a forecast. Incomplete observations appear after complete results; unknown months are never zero-filled.</p>
          <table><thead><tr><th>Partner</th><th id="rank-unit">Value</th><th>Observed facts</th></tr></thead><tbody id="ranking"></tbody></table>
        </section>
      </div>
      <nav class="tabs" role="tablist" aria-label="Details">
        <button id="tab-trend" class="tab" role="tab" aria-selected="false" aria-controls="panel-trend" type="button">Monthly trend</button>
        <button id="tab-compare" class="tab" role="tab" aria-selected="false" aria-controls="panel-compare" type="button">Comparison</button>
      </nav>
    </section>
    <aside class="agent" id="agent" aria-label="Data explorer assistant">
      <h2>DATA ASSISTANT</h2>
      <p class="caption agent-warning">Trade values are calculated from the explorer snapshot. AI interprets the question; verify its selected commodity, direction, period, and coverage.</p>
      <div id="agent-slot"><p class="caption">Sign in to ArcGIS Online to ask questions about this data in plain language.</p></div>
    </aside>
  </main>
  </div>
  <dialog id="splash" aria-labelledby="splash-title">
    <h2 id="splash-title">Before you explore</h2>
    <p class="warning"><strong>Unofficial, exploratory prototype.</strong> This is not a USDA or FAS product and must not be used for decision making, reporting or publication. Verify anything important against the official USDA FAS GATS system.</p>
    <h3>Methodology</h3>
    <ul>
      <li>Source: USDA FAS GATS API (U.S. Census Bureau trade data), monthly, September 2025 to August 2026.</li>
      <li>Commodity groups come from GATS BICO-HS10 reports (Bulk, Intermediate, Consumer-Oriented), downloaded 26 Oct 2026. Each group is a list of 10-digit HS codes.</li>
      <li>Values are nominal U.S. dollars of customs value. Exports are domestic exports (re-exports excluded); imports are general imports. Independent Census reconciliation covered the original five partners; additional partners use the same source and aggregation but have not been independently reconciled.</li>
      <li>This prototype shows trade value only. Quantities are not shown because units differ across commodities and many groups have no single mass unit.</li>
    </ul>
    <h3>Constraints</h3>
    <ul>
      <li id="partner-coverage"></li>
      <li>All commodities totals use the disjoint top-level BICO category rollups only; constituent group facts are excluded to prevent double-counting.</li>
      <li>Brighter, slightly thicker arrows indicate higher trade values within the displayed routes. Imports point to the U.S.; exports point to partners. At world scale, exports to the selected European partners share one summed arrow; zoom in or select a country to see individual arrows. Regional and individual flows are never counted together. Dashed gray arrows mean incomplete or unknown values, not low trade.</li>
      <li>BICO group codes, names and membership differ by direction, so the commodity list changes when you switch between exports and imports. Imports have no Corn or Soybeans group; use Coarse Grains and Oilseeds there, which are broader. Do not compare directions for those.</li>
      <li>The membership lists are one snapshot; whether they changed across years is unconfirmed.</li>
      <li>Missing months are unknown, not zero. Recent months may be revised.</li>
    </ul>
    <p class="caption" id="provenance"></p>
    <button id="splash-accept" type="button" autofocus>I understand. Continue</button>
  </dialog>`;

const splash = document.querySelector<HTMLDialogElement>("#splash")!;
document.querySelector("#about")!.addEventListener("click", () => splash.showModal());
splash.addEventListener("cancel", event => { if (!sessionStorage.getItem("splashAccepted")) event.preventDefault(); });
document.querySelector("#splash-accept")!.addEventListener("click", () => {
  sessionStorage.setItem("splashAccepted", "1");
  splash.close();
});
if (!sessionStorage.getItem("splashAccepted")) splash.showModal();

const tabIds = ["trend", "compare"] as const;
function openTab(active: (typeof tabIds)[number] | null) {
  document.getElementById("drawer")!.hidden = active === null;
  for (const id of tabIds) {
    document.getElementById(`panel-${id}`)!.hidden = id !== active;
    document.getElementById(`tab-${id}`)!.setAttribute("aria-selected", String(id === active));
  }
}
for (const id of tabIds) {
  document.getElementById(`tab-${id}`)!.addEventListener("click", () => {
    const open = document.getElementById(`tab-${id}`)!.getAttribute("aria-selected") === "true";
    openTab(open ? null : id);
  });
}
document.addEventListener("keydown", event => { if (event.key === "Escape") openTab(null); });
document.querySelector(".menu")!.addEventListener("click", event => {
  if ((event.target as HTMLElement).tagName === "BUTTON") (event.currentTarget as HTMLDetailsElement).open = false;
});

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = (id: string) => element<HTMLSelectElement>(id);
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const monthLabel = (month: string) => new Date(`${month.slice(0, 4)}-${month.slice(4)}-01T12:00:00Z`)
  .toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const showError = (message: string) => {
  element("error").hidden = false;
  element("error").textContent = message;
};
const format = (value: number | null) => value === null ? "No reported rows" : number.format(value);
function saveCsv(filename: string, rows: (string | number | null)[][]) {
  const quote = (value: string | number | null) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = rows.map(row => row.map(quote).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.hidden = true;
  document.body.append(link); link.click();
  setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 1000);
}
const clientId = import.meta.env.VITE_ARCGIS_CLIENT_ID as string | undefined;
const webMapId = import.meta.env.VITE_FAS_WEBMAP_ID as string | undefined;
const PORTAL = "https://esrifederal.maps.arcgis.com";
const DEFAULTS = { mode: "commodity", partner: "all", commodity: "all", direction: "exports", period: "all" };
const SUGGESTED_PROMPTS = [
  "Which partner had the highest wheat exports?",
  "Show Japan beef exports for the whole period.",
  "Compare corn and soybean exports to Mexico."
];
let resetExplorer: () => void = () => {};

if (clientId) {
  esriId.registerOAuthInfos([new OAuthInfo({
    appId: clientId, portalUrl: PORTAL, popup: true,
    popupCallbackUrl: `${location.origin}/oauth-callback.html`
  })]);
}

async function isSignedIn(): Promise<boolean> {
  if (!clientId || !webMapId) return false;
  try {
    await esriId.checkSignInStatus(`${PORTAL}/sharing`);
    return true;
  } catch {
    return false;
  }
}

function showAgentPlaceholder() {
  const slot = element("agent-slot");
  if (!clientId || !webMapId) {
    slot.innerHTML = `<p class="caption">The assistant is not configured for this build. It needs an ArcGIS Online app (VITE_ARCGIS_CLIENT_ID) and a web map (VITE_FAS_WEBMAP_ID).</p>`;
    return;
  }
  slot.innerHTML = `<p class="caption">Sign in to ArcGIS Online to ask questions about this data in plain language. The explorer works without signing in.</p><p class="caption">For organizational sign-in and MFA, open this page in Chrome or Edge and allow the sign-in popup. VS Code's embedded browser may block authentication.</p><button id="agent-signin" type="button">Sign in</button>`;
  // Popups need a user gesture, so sign-in starts from this click.
  element("agent-signin").onclick = async () => {
    try {
      const view = document.querySelector("arcgis-map")!.view;
      if (view?.ready && view.viewpoint) {
        sessionStorage.setItem(SIGNIN_VIEWPOINT_KEY, JSON.stringify(view.viewpoint.toJSON()));
      }
      await esriId.getCredential(`${PORTAL}/sharing`);
      location.reload();
    } catch (error) {
      sessionStorage.removeItem(SIGNIN_VIEWPOINT_KEY);
      showError(`Sign-in was cancelled or failed: ${error instanceof Error ? error.message : String(error)}. The explorer still works without the assistant.`);
    }
  };
}

function mountAgent(data: Dataset) {
  const slot = element("agent-slot");
  slot.innerHTML = `<arcgis-assistant reference-element="#map" heading="Ask the data"
      description="Trade totals and rankings are calculated from the explorer snapshot, not monthly maxima."
      entry-message="Hello. I can answer questions about the pilot trade values for ${data.partners.length} selected partners.">
      <arcgis-assistant-agent></arcgis-assistant-agent>
      <arcgis-assistant-help-agent></arcgis-assistant-help-agent></arcgis-assistant>`;
  const assistant = slot.querySelector("arcgis-assistant")!;
  assistant.querySelector("arcgis-assistant-agent")!.agent = createTradeAgent(data).registration;
  assistant.suggestedPrompts = SUGGESTED_PROMPTS;
  installAssistantPresentation(assistant);
  // The agent's answers are not tied to the dropdowns, so start each question from a clean state.
  assistant.addEventListener("arcgisSubmit", () => resetExplorer());
}

async function loadLocal(): Promise<Dataset> {
  const response = await fetch("/prototype-data.json");
  if (!response.ok) throw new Error("Pilot missing. Run tools\\Invoke-FasPilot.ps1.");
  return response.json();
}

async function start() {
  const signedIn = await isSignedIn();
  const data: Dataset = await loadLocal();
  document.querySelector(".badge")!.textContent = signedIn ? "SIGNED IN · ASSISTANT ON" : "LOCAL PILOT";
  if (signedIn) element("agent-slot").textContent = "Loading the assistant's web map…";
  else showAgentPlaceholder();
  if (!Array.isArray(data.partners) || data.partners.length < 1 || !Array.isArray(data.commodities) || data.commodities.length < 1 ||
      data.months.length !== 12 || data.records.length < 1) {
    throw new Error("Pilot dataset is missing partners, commodities, months, or facts. Prepare the pilot first.");
  }
  const available = new Set(data.commodities.flatMap(c => c.directions.map(d => `${d}/${c.id}`)));
  const keys = new Set<string>();
  for (const fact of data.records) {
    const key = `${fact.partnerCode}/${fact.commodityId}/${fact.direction}/${fact.month}`;
    if (keys.has(key) || !data.partners.some(p => p.code === fact.partnerCode) ||
        !available.has(`${fact.direction}/${fact.commodityId}`) || fact.mappingVersion !== data.mappingVersion ||
        !data.months.includes(fact.month) ||
        (fact.status === "observed" ? fact.valueUsd === null : fact.status !== "no_reported_rows" || fact.valueUsd !== null || fact.quantityMt !== null)) {
      throw new Error("Invalid or duplicate pilot fact.");
    }
    keys.add(key);
  }
  const params = new URLSearchParams(location.search);
  const commodityNote = { text: "" };
  const fillCommodities = (keep?: string) => {
    const direction = select("direction").value as Direction;
    const previous = (keep ?? select("commodity").value) || "all";
    const previousName = data.commodities.find(c => c.id === previous)?.name;
    const menu = select("commodity");
    menu.replaceChildren();
    menu.add(new Option("All commodities", "all"));
    const sections: Record<string, HTMLOptGroupElement> = {};
    for (const commodity of data.commodities) {
      const group = commodity.groups[direction];
      if (!group) continue;
      let section = sections[group.category];
      if (!section) {
        section = document.createElement("optgroup"); section.label = group.category;
        sections[group.category] = section; menu.append(section);
      }
      section.append(new Option(commodity.name, commodity.id));
    }
    const exists = Array.from(menu.options).some(o => o.value === previous);
    menu.value = exists ? previous : "all";
    commodityNote.text = previous && !exists && previousName
      ? `${previousName} has no matching BICO group for ${direction}; showing ${menu.selectedOptions[0].text} instead. ` : "";
  };
  select("partner").add(new Option(`All ${data.partners.length} selected partners`, "all"));
  for (const partner of data.partners) select("partner").add(new Option(partner.name, partner.code));
  for (const month of data.months) select("period").add(new Option(monthLabel(month), month));
  const slider = element<HTMLInputElement>("timeline-month");
  const play = element<HTMLButtonElement>("timeline-play");
  const allMonths = element<HTMLButtonElement>("timeline-all");
  slider.max = String(data.months.length);
  let playback: ReturnType<typeof setInterval> | undefined;
  const pauseTimeline = () => {
    clearInterval(playback);
    playback = undefined;
    play.textContent = "Play";
    play.setAttribute("aria-pressed", "false");
  };
  function syncTimeline() {
    const index = data.months.indexOf(select("period").value);
    slider.value = String(index + 1);
    const label = index < 0 ? "All 12 months" : monthLabel(data.months[index]);
    slider.setAttribute("aria-valuetext", label);
    element("timeline-label").textContent = label;
    allMonths.disabled = index < 0;
  }
  const choosePeriod = (period: string) => {
    pauseTimeline();
    select("period").value = period;
    render();
  };
  slider.oninput = () => choosePeriod(Number(slider.value) === 0 ? "all" : data.months[Number(slider.value) - 1]);
  allMonths.onclick = () => choosePeriod("all");
  play.onclick = () => {
    if (playback !== undefined) { pauseTimeline(); return; }
    const index = data.months.indexOf(select("period").value);
    if (index < 0 || index === data.months.length - 1) {
      select("period").value = data.months[0];
      render();
    }
    play.textContent = "Pause";
    play.setAttribute("aria-pressed", "true");
    playback = setInterval(() => {
      try {
        const next = data.months.indexOf(select("period").value) + 1;
        select("period").value = data.months[next];
        if (next === data.months.length - 1) pauseTimeline();
        render();
      } catch (error) {
        pauseTimeline();
        showError(`Timeline playback failed: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }, 1200);
  };
  document.addEventListener("visibilitychange", () => { if (document.hidden) pauseTimeline(); });
  window.addEventListener("pagehide", pauseTimeline);
  slider.disabled = false;
  play.disabled = false;
  const directionParam = params.get("direction");
  if (directionParam === "exports" || directionParam === "imports") select("direction").value = directionParam;
  fillCommodities(params.get("commodity") ?? "all");
  commodityNote.text = "";
  for (const id of ["partner", "period", "mode"]) {
    const value = params.get(id);
    if (value && Array.from(select(id).options).some(option => option.value === value)) select(id).value = value;
  }
  if (params.get("dataset") && params.get("dataset") !== data.version) {
    showError("The linked dataset version differs from the current pilot. These are current results, not an archived snapshot.");
  }
  element("subtitle").textContent = `U.S. trade · ${data.partners.length} selected partners · ${monthLabel(data.months[0])} – ${monthLabel(data.months.at(-1)!)}`;
  element("subtitle").title = data.partners.map(p => p.name).join(", ");
  element("partner-coverage").textContent = `${data.partners.length} selected partners: ${data.partners.map(p => p.name).join("; ")}. ${data.selectionBasis ?? "Selected coverage, not a worldwide ranking."} Every available BICO group and category is included.`;
  element("provenance").textContent = `Data extract ${data.version}, retrieved ${new Date(data.retrievedUtc).toLocaleDateString()}.`;
  let layer: GraphicsLayer | undefined;
  let flowLayer: GraphicsLayer | undefined;
  let mapScale = 147914381.8978885;
  let mapTrades: PartnerTrade[] = [];
  let closeFlowPopup = () => {};
  const graphics: Graphic[] = [];
  const currentMetric = (): "valueUsd" => "valueUsd";
  const selectedCommodityIds = () => commodityFactIds(data.commodities, select("direction").value as Direction, select("commodity").value);
  const selectedPartnerCodes = () => select("partner").value === "all"
    ? data.partners.map(partner => partner.code) : [select("partner").value];
  const selectedMonths = () => select("period").value === "all" ? data.months : [select("period").value];
  const aggregate = (partnerCodes: string[], months: string[]) =>
    aggregateFacts(data.records, partnerCodes, selectedCommodityIds(), select("direction").value as Direction, months);
  const monthly = (partnerCodes: string[]) => data.months.map(month => {
    const result = aggregate(partnerCodes, [month]);
    return { month, ...result, valueUsd: result.value };
  });
  const selectedRecords = () => {
    const partnerCodes = new Set(selectedPartnerCodes());
    const commodityIds = new Set(selectedCommodityIds());
    const months = new Set(selectedMonths());
    return data.records.filter(record => partnerCodes.has(record.partnerCode) &&
      commodityIds.has(record.commodityId) && record.direction === select("direction").value && months.has(record.month));
  };
  const rankings = () => data.partners.map(partner => ({ ...partner, ...aggregate([partner.code], selectedMonths()) }))
    .sort((a, b) => Number(b.complete) - Number(a.complete) || (b.value ?? -1) - (a.value ?? -1));
  let maximumKey = "";
  let monthlyMaximum = 0;

  function renderFlowMap() {
    if (!flowLayer) return;
    const direction = select("direction").value as Direction;
    const flows = buildTradeFlows(mapTrades, direction, mapScale, select("partner").value);
    const monthlyPeriod = select("period").value !== "all";
    if (monthlyPeriod) {
      const key = `${direction}/${select("commodity").value}/${select("partner").value}/${mapScale >= EUROPE_FLOW_SCALE}`;
      if (key !== maximumKey) {
        const trades = data.months.map(month => data.partners.map(partner =>
          ({ ...partner, ...aggregate([partner.code], [month]) })));
        monthlyMaximum = monthlyFlowMaximum(trades, direction, mapScale, select("partner").value);
        maximumKey = key;
      }
    }
    closeFlowPopup();
    flowLayer.removeAll();
    flowLayer.addMany(monthlyPeriod ? tradeFlowGraphics(flows, direction, monthlyMaximum) : tradeFlowGraphics(flows, direction));
    const regional = flows.find(flow => flow.region);
    const incomplete = flows.filter(flow => !flow.complete).length;
    element("legend").textContent = `Thin/dull → thicker/brighter: lower → higher USD, square-root scaled ${monthlyPeriod ? "against a fixed maximum across all 12 months for these routes" : "within displayed routes"}. ${direction === "imports" ? "Partner → U.S." : "U.S. → partner."} ${regional
      ? `${regional.name} is one summed export arrow; zoom in or click it to expand.`
      : "Individual partner arrows; select a country or click an arrow to focus."} ${incomplete ? `${incomplete} dashed gray routes have incomplete/unknown values; missing is not zero.` : ""} Complete zero-value routes are not drawn.`;
    element("map-status").textContent = `${flowLayer.graphics.length} trade arrows shown.${regional ? " Europe includes selected partners only, not the entire region." : ""}`;
  }

  function render() {
    syncTimeline();
    const partner = data.partners.find(p => p.code === select("partner").value);
    const commodity = data.commodities.find(c => c.id === select("commodity").value);
    const partnerCodes = selectedPartnerCodes();
    const months = monthly(partnerCodes);
    const rows = months.filter(row => select("period").value === "all" || row.month === select("period").value);
    const metric = currentMetric();
    const direction = select("direction").value as Direction;
    const total = aggregate(partnerCodes, selectedMonths());
    const commodityName = commodity?.name ?? "All commodities";
    const partnerName = partner?.name ?? `all ${data.partners.length} selected partners`;
    const unit = metric === "valueUsd" ? "USD" : "MT";
    element("selection").textContent = `${direction === "exports" ? `U.S. → ${partnerName}` : `${partnerName} → U.S.`} / ${select("period").value === "all" ? "12 MONTHS" : monthLabel(select("period").value)}`;
    element("total").textContent = total.value !== null ? `$${format(total.value)} ${unit}` : "No reported rows";
    const categoryNames = [...new Set(data.commodities.filter(item =>
      item.kind === "category" && item.directions.includes(direction)).map(item => item.category))];
    const coverage = select("commodity").value === "all"
      ? `All covered BICO categories (${categoryNames.join(", ")}); category rollups only, constituent groups excluded.`
      : `${commodityNote.text}${commodity?.groups[direction]?.description ?? ""}`;
    element("coverage").textContent = coverage;
    const observationLabel = select("commodity").value === "all" ? "partner/category-month facts" : "partner-month facts";
    element("completeness").textContent = `${total.observed}/${total.expected} ${observationLabel} have reported values.${total.complete ? "" : " Partial observed sum only; missing values are unknown, not zero."}`;
    const index = months.findIndex(row => row.month === select("period").value);
    const previous = index > 0 ? months[index - 1][metric] : null;
    const current = index >= 0 ? months[index][metric] : null;
    element("change").textContent = previous !== null && previous !== 0 && current !== null
      ? `${number.format((current / previous - 1) * 100)}% vs previous month` : "No comparable prior observation for month-over-month change.";
    element("map-title").textContent = `${commodityName}: ${partner ? `${partner.name} detail` : `${data.partners.length}-partner overview`}`;
    element("table-title").textContent = `${partnerName}: monthly observations`;
    element("trend-title").textContent = `${partnerName}: monthly trajectory`;
    element("chart-unit").textContent = unit;
    const max = Math.max(...months.map(row => row[metric] ?? 0), 1);
    element("bars").replaceChildren();
    for (const row of months) {
      const button = document.createElement("button");
      button.className = "bar";
      button.setAttribute("aria-label", `${monthLabel(row.month)}: ${format(row[metric])}${row[metric] === null ? "" : ` ${unit}`}`);
      button.setAttribute("aria-pressed", String(row.month === select("period").value));
      const track = document.createElement("span"); track.className = "bar-track";
      const fill = document.createElement("span");
      fill.style.height = row[metric] === null ? "0" : `${Math.max(1, row[metric]! / max * 100)}%`;
      track.append(fill);
      const label = document.createElement("span"); label.textContent = `${monthLabel(row.month)}${row[metric] === null ? " N/A" : ""}`;
      button.append(track, label);
      button.onclick = () => choosePeriod(row.month);
      element("bars").append(button);
    }
    element("rows").replaceChildren();
    for (const row of rows) {
      const tr = document.createElement("tr");
      const status = row.observed === 0 ? "No reported values"
        : row.complete ? `${row.observed}/${row.expected} included facts`
          : `${row.observed}/${row.expected} facts; partial sum`;
      for (const text of [monthLabel(row.month), format(row.valueUsd), status]) {
        const td = document.createElement("td"); td.textContent = text; tr.append(td);
      }
      element("rows").append(tr);
    }
    const ranked = rankings();
    element("rank-unit").textContent = unit;
    element("ranking").replaceChildren();
    for (const item of ranked) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      const button = document.createElement("button"); button.className = "partner-link";
      button.textContent = `${item.name}${item.code === partner?.code ? " (selected)" : ""}`;
      button.onclick = () => { select("partner").value = item.code; render(); };
      name.append(button); tr.append(name);
      for (const text of [format(item.value) + (item.complete ? "" : " · incomplete"), `${item.observed}/${item.expected}`]) {
        const td = document.createElement("td"); td.textContent = text; tr.append(td);
      }
      element("ranking").append(tr);
    }
    mapTrades = ranked;
    if (layer) {
      for (const graphic of graphics) {
        const selected = graphic.attributes.partnerCode === partner?.code;
        graphic.symbol = new SimpleFillSymbol({
          color: selected ? [104, 220, 255, 0.06] : [0, 0, 0, 0],
          outline: { color: selected ? "#68dcff" : [118, 141, 161, 0.35], width: selected ? 1.7 : 0.5 }
        });
      }
    }
    renderFlowMap();
    const state = { version: 3, dataset: data.version, mapping: data.mappingVersion, partner: partner?.code ?? "all", commodity: select("commodity").value, direction, metric, period: select("period").value, mode: select("mode").value };
    const url = new URL(location.href);
    url.searchParams.delete("variant");
    for (const [key, value] of Object.entries(state)) url.searchParams.set(key, String(value));
    history.replaceState(null, "", url);
  }
  for (const id of ["partner", "commodity", "mode"]) select(id).onchange = render;
  select("period").onchange = () => choosePeriod(select("period").value);
  select("commodity").onchange = () => { commodityNote.text = ""; render(); };
  select("direction").onchange = () => { fillCommodities(); render(); };
  const groupOf = (commodityId: string, direction: string) =>
    data.commodities.find(c => c.id === commodityId)?.groups[direction as Direction];
  const coverageOf = (commodityId: string, direction: Direction) => commodityId === "all"
    ? `Disjoint BICO category rollups only (${data.commodities.filter(c => c.kind === "category" && c.directions.includes(direction)).map(c => c.name).join("; ")}); groups excluded.`
    : groupOf(commodityId, direction)?.description ?? "";
  const caveat = data.assumptions.join(" ");
  element("download").onclick = () => saveCsv("fas-pilot-monthly.csv", [
    ["partnerCode", "commodityId", "bicoCode", "mappingVersion", "month", "direction", "valueUsd", "quantityMt", "status", "includedHs10Count", "sourceUrl", "datasetVersion", "retrievedUtc", "coverage", "caveats"],
    ...selectedRecords().map(row => [
      row.partnerCode, row.commodityId, row.bicoCode ?? null, row.mappingVersion, row.month, row.direction, row.valueUsd, row.quantityMt, row.status,
      row.includedCount, row.sourceUrl, data.version, data.retrievedUtc,
      groupOf(row.commodityId, row.direction)?.description ?? "", caveat
    ])
  ]);
  element("download-ranking").onclick = () => saveCsv("fas-pilot-selected-partners.csv", [
    ["partnerCode", "partnerName", "commodityId", "mappingVersion", "direction", "metric", "period", "observedSum", "observedFacts", "expectedFacts", "datasetVersion", "coverage", "commodityDefinition", "caveats"],
    ...rankings().map(p => [p.code, p.name, select("commodity").value, data.mappingVersion, select("direction").value, currentMetric(), select("period").value, p.value, p.observed, p.expected, data.version, `Selected ${data.partners.length} partners only; not a world ranking.`, coverageOf(select("commodity").value, select("direction").value as Direction), caveat])
  ]);
  render();
  try {
    const boundaries = new GeoJSONLayer({ url: "/partner-boundaries.geojson" });
    const query = boundaries.createQuery();
    query.where = `ISO IN (${data.partners.map(p => `'${p.iso}'`).join(",")})`;
    query.outFields = ["ISO", "COUNTRY"]; query.returnGeometry = true;
    const features = await boundaries.queryFeatures(query);
    boundaries.destroy();
    if (!features.spatialReference) {
      throw new Error("Country boundary response has no spatial reference.");
    }
    for (const [index, partner] of data.partners.entries()) {
      const matches = features.features.filter(g => g.attributes.ISO === partner.iso);
      if (matches.length !== 1) throw new Error(`No unique boundary for ${partner.name}.`);
      graphics.push(new Graphic({ geometry: matches[0].geometry, attributes: { ObjectID: index + 1, partnerCode: partner.code, name: partner.name } }));
    }
    layer = createCountryOverlay(graphics);
    const mapEl = document.querySelector("arcgis-map")!;
    if (signedIn) {
      mapEl.itemId = webMapId!;
    } else {
      mapEl.basemap = "dark-gray-vector";
    }
    await mapEl.viewOnReady();
    const view = mapEl.view;
    if (!view.map) throw new Error("Map view has no map.");
    const map = view.map;
    view.popupEnabled = false;
    closeFlowPopup = () => view.closePopup();
    map.basemap = "dark-gray-vector";
    if (!map.basemap) throw new Error("The dark basemap could not initialize.");
    await map.basemap.load();
    view.constraints.snapToZoom = false;
    const savedViewpoint = sessionStorage.getItem(SIGNIN_VIEWPOINT_KEY);
    try {
      initializeMapViewpoint(view, savedViewpoint);
    } catch (error) {
      showError(`Could not restore the sign-in viewpoint: ${error instanceof Error ? error.message : String(error)}.`);
      initializeMapViewpoint(view, null);
    } finally {
      sessionStorage.removeItem(SIGNIN_VIEWPOINT_KEY);
    }
    map.add(layer);
    flowLayer = createTradeFlowOverlay();
    map.add(flowLayer);
    mapScale = view.scale;
    watch(() => view.scale >= EUROPE_FLOW_SCALE, () => {
      mapScale = view.scale;
      renderFlowMap();
    });
    const originalFilters = new Map<string, string | null>();
    for (const other of map.allLayers.toArray()) {
      if (other instanceof FeatureLayer) originalFilters.set(other.id, other.definitionExpression ?? null);
    }
    resetExplorer = () => {
      pauseTimeline();
      select("mode").value = DEFAULTS.mode;
      select("direction").value = DEFAULTS.direction;
      select("period").value = DEFAULTS.period;
      select("partner").value = DEFAULTS.partner;
      fillCommodities(DEFAULTS.commodity);
      commodityNote.text = "";
      for (const other of map.allLayers.toArray()) {
        if (other instanceof FeatureLayer && originalFilters.has(other.id)) {
          other.definitionExpression = originalFilters.get(other.id) ?? "";
        }
      }
      render();
    };
    view.on("click", async event => {
      const hit = await view.hitTest(event, { include: [layer!, flowLayer!] });
      const graphic = hit.results.find(result => result.type === "graphic");
      if (graphic?.type === "graphic") {
        if (graphic.graphic.attributes.region) {
          try {
            await view.goTo({ center: [9, 50], scale: EUROPE_FLOW_SCALE / 2 });
          } catch (error) {
            if (!(error instanceof Error && error.name === "AbortError")) showError(`Could not expand Europe: ${error instanceof Error ? error.message : String(error)}.`);
          }
        } else if (graphic.graphic.attributes.partnerCode) {
          const code = graphic.graphic.attributes.partnerCode;
          select("partner").value = code; render();
          const currentFlow = flowLayer!.graphics.find(flow => flow.attributes.partnerCode === code);
          if (currentFlow) view.openPopup({ features: [currentFlow], location: event.mapPoint });
        }
      }
    });
    render();
    if (signedIn) mountAgent(data);
  } catch (error) {
    element("map-status").textContent = `Map unavailable: ${error instanceof Error ? error.message : String(error)}. Tables remain usable.`;
    if (signedIn) element("agent-slot").textContent = "Assistant unavailable because the web map could not initialize. See the map status for details.";
  }
}
start().catch(error => showError(error instanceof Error ? error.message : String(error)));
