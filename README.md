# FAS explorer: throwaway vertical-slice prototype

This local prototype asks whether a country map, monthly trends, and explicit
query state make the saved FAS sample useful. It is not production software.
Organizational authentication and a validated calculation assistant are available.
Worldwide rankings and scheduled ingestion are not implemented.

## Run

```powershell
npm ci
npm run prototype
```

Open the localhost URL printed by Vite. The repository includes the generated
public-source trade snapshot, so the basic explorer does not need FAS API
credentials or a new collection run. The assistant requires your own ArcGIS
configuration and organizational sign-in; local environment files are excluded
from Git. Publishing this repository does not deploy a website or publish any
ArcGIS items.

For ongoing edits in VS Code, use the same local folder and development server.
Run `npm test` and `npm run build` before committing. Review Source Control
changes, commit, then push to GitHub. Keep credentials, private exports, and
raw local collection evidence outside the repository.

### Current frontend presentation

The desktop explorer uses a dark, terminal-inspired palette, amber controls,
monospaced figures, and a dark gray basemap. Calcite dark mode and shared color
tokens also theme the Esri assistant.

The opening state shows all 20 selected partners and all covered BICO commodities,
with no selected country. Totals sum only direction-specific category rollups,
never those rollups plus their constituent groups. The trend drawer aggregates
the current partner selection; comparison covers all selected partners.

### Twenty selected partners

Coverage is an informed selection, **not a computed top 20**:
Canada, Mexico, Brazil, Japan, China, South Korea, Taiwan, Vietnam, India,
Indonesia, Thailand, Australia, United Kingdom, Germany, Netherlands, France,
Italy, Spain, Colombia and Chile. The selection is broadly informed by
[USDA ERS's overview of key trade partners](https://www.ers.usda.gov/topics/international-markets-us-trade/countries-regions),
not a ranking calculation for the loaded reporting window. EU countries are
individual partners; an EU aggregate is not added, avoiding regional overlap.

[partners.json](prototype/partners.json) defines FAS codes and ISO alpha-2 map
identifiers. France, Italy and Australia use current FAS codes **F1, I1 and A2**,
not discontinued FR, IT and AS. UI labels, CSV coverage and the assistant's
catalog derive from the loaded partner list.

The reporting window remains September 2025–August 2026, with all 83 commodity
definitions and 27,840 monthly facts. The original five partners' verified raw
files are reused unchanged; the other 15 use newly retrieved FAS records.
Retrieval timestamps and hashes are retained in the external source manifest.
New-country independent Census reconciliation has **not** been performed.
The current extract is `20261026T194351866592Z`: 22,559 observed facts and
5,281 unknowns. Category-level overview coverage is complete (960/960 per
direction): exports total $147,119,779,637; imports total $188,316,494,329.
Validation passes 54 Node tests and four Python tests, plus the production
build. Original five-country numeric regressions retain their original
candidate set; additional tests exercise all twenty.

Country outlines and click targets read local
[partner-boundaries.geojson](public/partner-boundaries.geojson), prepared from
public-domain Natural Earth 1:110m boundaries. These are generalized display
context, not official borders or a political statement. The earlier public
country service omitted a separate Taiwan feature and returned multiple Spain
features, so it could not safely support this set with unique ISO matching.
The temporary GeoJSON query layer is never added to the saved web map; only
display-only GraphicsLayers are added for outlines and trade arrows. Hosted facts/metadata remain
the original five-country snapshot; no publication or embedding changes are
needed for the custom calculation agent to use all 20 local partners.

### Directional trade arrows

The timeline above the map supports manual scrubbing and Play/Pause at
1.2 seconds per month. Its first position and **All 12 months** button restore
the full-window overview. Playback starts at September 2025 when the overview
or final month is selected, and stops after August 2026. Manual period changes
(including chart bars) pause playback; switching tabs away from the app or
submitting an assistant question also pauses it. Totals, comparisons, chart
selection, CSV scope and URL period remain synchronized. Frames show monthly,
not cumulative values. Monthly arrow intensity uses a fixed twelve-month
maximum for the active direction, commodity, partner and regional grouping;
changing those filters or zoom grouping recalibrates the scale. Missing values
remain dashed gray.

The map now uses curved arrows rather than value-shaded country polygons:

- **Imports:** individual partner-to-U.S. arrows at every zoom level, in amber.
- **Exports:** U.S.-to-partner arrows in mint. With no country selected and
  scale at or beyond 1:50,000,000, the UK, Germany, Netherlands, France, Italy
  and Spain share one **Europe (6 selected partners)** arrow. Zooming closer
  splits it into individual arrows. Clicking the regional arrow zooms to
  Europe; selecting any country shows only that country's arrow, even at
  world scale. Zooming out with all partners selected restores the group.
- Width (0.9–4 points), brightness and opacity increase monotonically with
  square-root-scaled USD relative to the largest complete displayed route.
  This is a visual scale, not a change to the trade values. It recalibrates
  when routes/filters change; use numeric totals for cross-view comparisons.
  For individual months, the maximum is fixed across all twelve months for
  the selected direction, commodity and displayed route configuration.
- Region sums replace, never accompany, their constituent country arrows.
  Only the six loaded European partners are included—not all Europe or an
  EU aggregate. The regional arrow is $17,139,062,769 for the full-window
  all-commodity exports. Zoom/grouping never changes the tables or totals.
- Incomplete and unknown values use dashed gray arrows without a
  value-intensity encoding; unknowns are never zero-filled. Complete zero
  routes are not drawn. Popups show values and partial status; filtering or
  changing grouping closes old popups rather than leaving stale values.
- Neutral country outlines remain clickable; cyan outlines identify a
  selected partner. Arrows are illustrative connections between approximate
  country display anchors and a central U.S. hub, **not shipping routes,
  ports, official centroids or transport volumes**. Pacific paths use the
  short dateline crossing and render in wrapped map copies.

[trade-flows.ts](prototype/trade-flows.ts) owns direction, safe regional
membership/sums, styling and curved paths.
[trade-flow-overlay.ts](prototype/trade-flow-overlay.ts) creates only
display-only graphics. The saved web map, hosted layer and AI embeddings are
unchanged; a regression checks both display overlays against actual SDK
registry restoration. New partners need an explicit display anchor in the
flow module; absent anchors fail visibly rather than drawing a guessed route.

Validated with 62 Node tests and a production build. Browser checks confirmed
20 import arrows, 15 world-scale export arrows, 20 after clicking Europe,
one France arrow under filtering, destination arrowheads including wrapped
Pacific endpoints, and popup cleanup. Full overview totals remain unchanged.

The map uses the same initial scale in local and signed-in modes rather than
inheriting the saved web map's zoomed-out viewpoint. Before the in-app OAuth
sign-in reload, its geometry, scale, and rotation are saved in session storage
and restored once on initialization. No hosted map or embeddings are modified.

The assistant presentation adapter uses the SDK's public block-content slot and
sanitized Markdown renderer to unwrap recognized serialized text-block arrays.
SDK streamed `data.parts` are already-rendered HTML, not raw model text.
For a single-block response the adapter unwraps the completed message's raw
`content`; static/raw text blocks are also supported. This avoids parsing HTML
as JSON or changing unrelated structured blocks.
Explicit USD amounts in prose are displayed with dollar signs and grouping
separators, preserving precision. Ordinary numbers, code, and links are not
treated as currency.

### Validated trade calculations

The assistant registers a custom SDK `FunctionAgent` instead of the stock
data-exploration agent for trade questions. The LLM produces a version-2
analytical query, not trade values or executable SQL/code.
`trade-calculation.ts` validates the query and calculates results using
the same local snapshot as the explorer. The SDK help agent remains available.
The contract is independent of the UI dropdowns:

- **Aggregate:** sum USD, optionally grouped by partner, commodity, or month.
- **Rank:** aggregate, then sort ascending/descending with a starting rank and
  count. Ties share a dense rank; all ties at a requested rank are included.
- **Compare:** two independent selections; side-by-side values, dollar
  difference, dollar/percentage change, ratio, or subset share.
- Selections support partner/commodity arrays or all; exports/imports; the
  full window, explicit month sets, or inclusive month ranges.
- Definitions and requests needing clarification have explicit operations.

There is no question-text parsing in the calculator. For example, the LLM
expresses "second highest" as descending rank, start rank 2, count 1.
No period specified means the entire loaded reporting window; no partner or
commodity specified means all covered partners/commodities. Answers are concise:
"Mexico is the partner with the highest value of wheat exports, at $1,184,773,992."
Snapshot IDs and fact counts are omitted. An explicitly selected month is named;
partial totals and incomplete ranking coverage retain a brief caveat.
The agent retains the last successfully validated analytical query for
follow-up interpretation; clarification, definitions, and failed requests do
not overwrite it. A new SDK conversation ID or app reload starts fresh.
Self-contained questions
use their own selections/defaults rather than stale dropdown state.

For "Which partner had the highest wheat exports?" the full-period Mexico
total is **$1,184,773,992**, not its September 2025 monthly value of $126,343,112.
Missing facts remain unknown. Rankings sort numeric observed sums, not
completeness; incomplete coverage prevents a definitive full-data ranking.
All-commodity totals include category rollups only. Commodity grouping/ranking
with all enumerates constituent groups only. Overlapping category/group
selections, duplicate selections/facts, and unavailable direction-specific
groups are rejected. Derived comparisons require complete values; percentages
and ratios with a zero baseline/denominator are undefined. Shares require the
numerator selection to be a subset of the denominator in the same direction.
Unsupported query shapes fail explicitly rather than reverting to a monthly
maximum. Quantities, worldwide rankings, forecasts, and dates outside the
loaded window remain unsupported.

The model's interpretation and orchestration remain AI-generated: verify the
selected commodity, direction, dates, and scope. Automated graph tests inject a
query producer to test calculations without authentication or model calls;
the authenticated model/orchestrator path was also confirmed by the user in
Chrome/Edge for the earlier highest-wheat-exports question: Mexico, $1,184,773,992,
September 2025–August 2026. China (3/12) and Brazil (2/12) were correctly
identified as partial observed sums. This does not verify interpretation of
the new version-2 contract or arbitrary questions.

The ten examples in [trade-acceptance.ts](prototype/trade-acceptance.ts) cover
totals, second place, top commodity groups, monthly imports, country comparisons,
month-over-month dollar/percentage change, two commodities, exports vs imports,
peak month, and a commodity's share. Automated tests assert exact snapshot
values through both the calculation interface and actual SDK FunctionAgent
graph with injected queries. They do **not** call the model. The same ten
cases also passed an injected-query browser smoke test.

To separately check real interpretation, sign in in external Chrome/Edge and
run this in that page's developer console (development server only; makes ten
organizational AI requests). It uses the same SDK prompt/schema/model helper
as the agent, but does not exercise the assistant's top-level orchestrator.
It compares the selected analytical parameters, not just successful execution;
period representations and selection ordering are normalized. Other valid
query shapes can be reported as mismatches and should be inspected.

```js
const { evaluateTradeAcceptance } = await import("/prototype/trade-acceptance.ts");
const response = await fetch("/prototype-data.json");
if (!response.ok) throw new Error("Snapshot unavailable");
const checks = await evaluateTradeAcceptance(await response.json());
console.table(checks.map(({ question, passed, answer }) => ({ question, passed, answer })));
```

This reports no credentials. Model errors stop the run rather than producing
success-shaped fallbacks. Live version-2 interpretation still needs this
authenticated acceptance run and ordinary assistant-panel follow-up testing.

`Publish-FasPilot.py` now describes period aggregation and rollup safety for
future publication, but existing hosted items, metadata, and embeddings were
not changed. The custom calculation agent receives catalog/semantic context
directly and does not depend on updated layer embeddings for its arithmetic.

Use an external Chrome or Edge window for AGOL organizational sign-in/MFA,
with the OAuth popup allowed. VS Code's embedded browser can block this flow;
its cookies and login session are separate from your external browser.

### Assistant embedding compatibility

The assistant's saved web map and its AI embeddings must contain the same feature
layers and fields. The app renders country outlines and trade arrows in
display-only `GraphicsLayer`s, which do not enter the assistant's feature-layer registry.
Do not replace that overlay with a client-side `FeatureLayer`: it causes
`Layer count mismatch during registry restoration. Regenerate embeddings.`
even when the saved web map's embeddings are current. The assistant mounts only
after the web map and filter-reset handler are ready.

`npm test` includes a regression against the installed AI SDK's registry-restoration
code. If an SDK update changes that internal function, update the regression
harness rather than skipping it.

Fetch and prepare the selected partners using the encrypted local FAS key:

```powershell
.\tools\Invoke-FasPilot.ps1
npm install
npm run prototype
```

Open the local URL printed by Vite. Option A (map first) is the selected layout.
Country selection, selected-partner rankings, monthly trade arrows, and CSV exports
use the same filter state. Missing matching records remain unknown, not zero.
To reprepare without network requests, run `python .\prototype\prepare_sample.py
--source "<saved pilot evidence directory>"` on one line.

`npm run build` checks TypeScript and builds the prototype. Public Esri basemap
and country services require internet access. The Python preparation step
requires only the standard library and verifies source-extract hashes.

The collection wrapper defaults to [partners.json](prototype/partners.json).
Use `-Source "<saved evidence directory>"` to reuse verified raw files and
preserve that extract's exact reporting window. A fresh collection without a
source instead selects the latest common released window. To continue after
interruption, add `-Resume "<collection directory printed at startup>"` with
the same partner/source configuration. Completed requests are hash-checked,
not downloaded again. At most three requests are in flight, with bounded
retry/backoff for throttling/transient failures. The browser dataset is only
replaced after the complete preparation validates successfully. `-Output`
can target a staging file for inspection before replacement.

Regenerate the display boundaries when the partner configuration changes:

```powershell
python .\tools\Prepare-PartnerBoundaries.py
python -m unittest discover -s tests -p test_country_preparation.py -v
```

This downloads public-domain Natural Earth data and saves only selected partner
geometries with source/hash metadata. `--source` can use saved GeoJSON offline.
The legacy publisher is deliberately blocked before any AGOL writes for new
countries lacking verified display-point metadata; do not republish merely to
expand this local assistant.

## Evidence and limits

- Twenty selected individual partners; all available BICO groups and categories;
  September 2025 through August 2026 (27,840 monthly facts, including unknowns).
  Rankings cover these selected partners, not a verified worldwide top twenty.
  Reported observations are saved source records; absent rows remain unknown.
  The fetcher selects the latest common consecutive 12 released months on refresh.
- Commodity groups come from the official GATS BICO-HS10 reports (exports:
  Schedule B; imports: HTS, general), parsed by `tools\Parse-BicoCrosswalk.py`
  into `prototype\bico-crosswalk-exports.json` and `...-imports.json` (downloaded
  2026-10-26). Each is a single current snapshot; whether membership changed
  across years is unconfirmed. `prepare_sample.py` selects members by BICO group
  (mapping version `gats-bico-crosswalk-2026-10-26`).
- Group codes and names differ by direction. Imports have no Corn or Soybeans
  group, so Corn / Coarse Grains (`0020AT`) and Soybeans / Oilseeds (`0065AT`)
  are broader on the import side and must not be compared with exports.
  Seed codes sit in Planting Seeds (`0120AT` exports, `0100AT` imports).
  The Canada Wheat export values still match the supplied GATS report.
- Rice quantities are reported mass converted to MT, not milled-equivalent.
  Never sum quantities across commodities.
- Value basis, verified against Census HS10 data (2026-10-26, via
  `tools\Invoke-CensusPilotReconciliation.ps1`, 332 partner/commodity/month cells):
  GATS export values equal Census **domestic** exports (`DF=1`) to the dollar in
  every cell; Census total exports (domestic + re-exports) differ in many cells,
  notably Rice. GATS import `value` equals Census **general imports**
  (`GEN_VAL_MO`) in every cell; consumption imports differ in one Rice cell.
  This verifies the HS10 sets reproduced GATS values at the time (inferred sets);
  the pilot now uses the official crosswalks above.
- The app shows a splash on first load (once per browser session) with the
  methodology, constraints, and an "unofficial, not for decision making" warning;
  it is reopened from the "Methodology & limits" link.
- Quantities convert source KG to MT explicitly; no price adjustment is made.
- Source extracts and credentials remain outside the project. The generated
  browser dataset includes only public trade data, source URLs, and provenance.
  The selected public-source snapshot is tracked in Git and **included in a
  local web build**. Credentials and raw collection evidence are not included.
  Do not deploy this prototype as an organization-secured application.
- No seed-exclusion inference should be promoted to production without
  authoritative membership and applicable flow/year definitions.

The browser query state is deterministic and shareable on the same local host;
the assistant calculates independently of dropdown state. Source and state are inspectable in
the page. CSV export follows the active partner, direction, and period; a separate
ranking export covers all selected partners. Incomplete observations are labeled
and placed after complete results rather than treated as full-period totals.

## Private publication: deferred

Target organization: `https://esrifederal.maps.arcgis.com`.
The user has ArcGIS Pro installed and is signed in with organizational MFA.
Frontend OAuth registration is explicitly deferred until deployment. No hosted
No publishing credentials have been collected; the private test below uses the
existing ArcGIS Pro session.

The read-only Pro-session check succeeded for Esri National Government
(`esrifederal.maps.arcgis.com`), with both
create-item and publish-hosted-feature privileges:

```powershell
& "C:\Program Files\ArcGIS\Pro\bin\Python\Scripts\propy.bat" .\tools\Test-ArcGISProAccess.py
```

The API may expose `https://www.arcgis.com/` as the connection URL even when
signed into the organization. The check verifies the returned organization
URL key/domain as well, rather than treating that shared URL as a wrong portal.
This proves interactive Pro-session access, not unattended scheduled access.

A future ArcGIS Pro publishing route must first verify the active portal,
identity, privileges, and approved access from the Pro Python environment.
An existing Pro session does not automatically authenticate the browser app.
Hosting on GitHub Pages does not make static files private; deployed viewers
still need properly authorized access to private ArcGIS services. Do not upload
the generated sample expecting its public static URL to enforce organization
membership. Actual hosted storage and credit cost remain unmeasured.

### Successful private publish test

Item: FAS Wheat Pilot - five selected partners - PRIVATE TEST.
Private item identifiers are retained only in local publication receipts.
Published through `GIS("pro")` on 2026-10-26 UTC.

- One hosted nonspatial table; all 120 rows and every published attribute were
  read back and compared to the prepared source.
- Owner-only/private access verified; no organization or public sharing enabled.
- Service capabilities are Query only; anonymous table query returned error 499.
- Source hash and created item ID are recorded outside the project under
  `%LOCALAPPDATA%\FasTradeExplorer\publication`.
- The initial item-size response was zero, which is not reliable evidence of
  free storage. Actual storage/credit usage remains unverified. Check the
  organization's storage reporting before scaling or creating further items.

`tools\Publish-FasPilot.py` performs this bounded test and refuses to create a
duplicate for a dataset version with an existing receipt. On failure it retains
the created item's ID for explicit review rather than silently deleting or
recreating content. The local frontend still uses its prepared JSON dataset,
not this private table; browser authentication remains deferred.

### Four-commodity expansion

Item: FAS Four-Commodity Pilot - five partners - PRIVATE TEST.
Private item identifiers are retained only in local publication receipts.

This separate owner-only, query-only feature service has two nonspatial tables:
`monthly_trade` (480 rows) and `commodity_definitions` (four rows). Every
published business attribute in both tables was checked against the prepared
source. Anonymous queries to both tables were rejected. The monthly fact key
is partner × commodity × month × direction; mapping version is recorded.

A single fact table simplifies cross-commodity filters, indexes, and refreshes;
separate tables per commodity would repeat schema/index overhead and require
query fan-out. A small definition table records provisional mapping rules and
their limitations without treating them as official BICO definitions. For this
small pilot, usability and maintainability matter more than theoretical byte
savings; no measured storage saving is claimed.

Storage testing was deferred at the user's request. The original 120-row Wheat
table was restored to its saved baseline after the interrupted refresh test;
all 120 business records were compared to the pre-test snapshot. Refresh
idempotence/rollback is NOT marked passed. The recovery utility uses bounded
authenticated REST requests because the high-level query had stalled during
the test. The original Wheat item remains private and was not replaced.

The frontend now loads this item after an ArcGIS OAuth popup sign-in (set
`VITE_ARCGIS_CLIENT_ID` in `.env.local`; redirect URI
`http://localhost:5173/oauth-callback.html`). Add `?source=local` to use the
prepared local JSON instead. Verified manually for the signed-in path only;
sign-out, session expiry, and access denial are untested.

## Natural-language query contract

The live assistant targets the version-2 analytical contract in
[prototype/trade-calculation.ts](prototype/trade-calculation.ts), not UI state.
`executeTradeQuery` returns structured results; `formatTradeResult` produces
concise prose. Tests and the SDK agent cross the same calculation interface.
A model chooses parameters but never supplies the numeric answers.

Partner and commodity ID schemas are constructed independently: reusing a
described Zod union can cause the SDK converter to emit `$ref` siblings
(`title`/`description`) that the AI service rejects with HTTP 400.
An offline regression checks the SDK converter's reference-reuse/title settings
as well as the model client's serialized transport; schema checks do not imply
authenticated model acceptance.

[prototype/explorer-query.ts](prototype/explorer-query.ts) remains a legacy
UI-shaped query/parser experiment with its original offline tests. It is not
the live assistant's interpreter, validator, or ranking implementation.
`npm test` includes its reconciled Canada wheat August 2026 export regression
alongside the current analytical, presentation, viewpoint, and embedding tests.
