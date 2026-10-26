"""Publish the expanded pilot as one owner-only hosted point layer plus a private web map.

Run without arguments to validate the data and print the plan (no ArcGIS Online writes).
Run with --publish to create the items. Esri's assistant agents read feature layers only,
so facts are points placed at an approximate partner display location, not borders.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

DISPLAY_POINTS = {  # approximate display locations (lon, lat), not official centroids
    "CA": (-106.3, 56.1), "MX": (-102.5, 23.6), "BR": (-51.9, -14.2),
    "JA": (138.3, 36.2), "CH": (104.2, 35.9),
}
FIELDS = [  # name, alias, length (None = double/integer)
    ("fact_key", "Fact key", 120), ("partner_code", "Partner code", 4), ("partner_name", "Partner country", 40),
    ("direction", "Trade direction (exports = U.S. exports to partner, imports = U.S. imports from partner)", 10),
    ("commodity_id", "Commodity ID", 60), ("commodity_name", "Commodity name", 80),
    ("commodity_category", "BICO category (Bulk, Intermediate, Consumer-Oriented, Agricultural & Related)", 40),
    ("commodity_kind", "Commodity kind (group or category rollup)", 10), ("bico_code", "BICO code", 10),
    ("year_month", "Month (YYYYMM)", 6),
    ("value_usd", "Monthly nominal USD customs value; SUM months for period totals", None),
    ("record_status", "Record status (observed or no_reported_rows)", 30),
    ("included_hs10_count", "Number of HS10 codes included", "int"),
    ("mapping_version", "Crosswalk version", 60), ("dataset_version", "Dataset version", 40),
    ("retrieved_utc", "Retrieved (UTC)", 40), ("source_url", "FAS API source URL", 400),
    ("coverage", "Commodity coverage description", 600),
]
LAYER_DESCRIPTION = (
    "Monthly U.S. agricultural trade value with five partner countries (Canada, Mexico, Brazil, Japan, China), "
    "September 2025 to August 2026, by GATS BICO commodity group. Exports are domestic exports; imports are general "
    "imports. Each row is one partner, commodity, direction and month. Empty value_usd means no reported rows (unknown, "
    "not zero). For period totals, SUM value_usd over the requested months, GROUP BY partner_code, then rank partner "
    "sums; do not rank monthly rows or use MAX(value_usd) as a period total. If no period is requested, use the full "
    "loaded window and state the dates. For all commodities, select commodity_kind='category' only, never category "
    "rollups together with constituent groups. Rank only the five covered partners, not the world. "
    "Points sit at an approximate display location per partner. Unofficial prototype; not for decision making."
)


def build_rows(data: dict) -> list[dict]:
    names = {p["code"]: p["name"] for p in data["partners"]}
    definitions = {c["id"]: c for c in data["commodities"]}
    rows, keys = [], set()
    for r in data["records"]:
        key = f"{r['partnerCode']}:{r['commodityId']}:{r['direction']}:{r['month']}"
        commodity = definitions.get(r["commodityId"])
        if key in keys or r["partnerCode"] not in names or commodity is None or r["month"] not in data["months"]:
            raise ValueError(f"Invalid or duplicate fact: {key}")
        keys.add(key)
        group = commodity["groups"][r["direction"]]
        rows.append({
            "fact_key": key, "partner_code": r["partnerCode"], "partner_name": names[r["partnerCode"]],
            "direction": r["direction"], "commodity_id": commodity["id"], "commodity_name": commodity["name"],
            "commodity_category": group["category"], "commodity_kind": commodity["kind"],
            "bico_code": r.get("bicoCode") or group["bicoCode"], "year_month": r["month"],
            "value_usd": r["valueUsd"], "record_status": r["status"],
            "included_hs10_count": r["includedCount"], "mapping_version": r["mappingVersion"],
            "dataset_version": data["version"], "retrieved_utc": data["retrievedUtc"],
            "source_url": r["sourceUrl"], "coverage": group["description"][:600],
        })
    return rows


def field_definitions() -> list[dict]:
    out = [{"name": "OBJECTID", "alias": "OBJECTID", "type": "esriFieldTypeOID"}]
    for name, alias, length in FIELDS:
        if length is None:
            out.append({"name": name, "alias": alias, "type": "esriFieldTypeDouble", "nullable": True})
        elif length == "int":
            out.append({"name": name, "alias": alias, "type": "esriFieldTypeInteger", "nullable": True})
        else:
            out.append({"name": name, "alias": alias, "type": "esriFieldTypeString", "length": length})
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--publish", action="store_true", help="Create items in ArcGIS Online.")
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / "public" / "prototype-data.json"
    raw = source.read_bytes()
    data = json.loads(raw)
    rows = build_rows(data)
    print(f"Validated {len(rows)} facts, {len(data['commodities'])} commodities, {len(data['partners'])} partners.")
    if not args.publish:
        print("Dry run only. Re-run with --publish to create the private layer and web map.")
        return
    if any(p["code"] not in DISPLAY_POINTS for p in data["partners"]):
        raise ValueError(
            "Expanded partner coverage is local only. Update and verify publisher display locations "
            "and hosted descriptions before publishing; no ArcGIS items have been created."
        )

    from arcgis.features import FeatureLayerCollection
    from arcgis.gis import GIS

    # Reuse the read-only organization/privilege gate before any mutation.
    spec = spec_from_file_location("pro_check", Path(__file__).with_name("Test-ArcGISProAccess.py"))
    check = module_from_spec(spec)
    spec.loader.exec_module(check)
    check.main()
    gis = GIS("pro")
    evidence = Path(os.environ["LOCALAPPDATA"]) / "FasTradeExplorer" / "publication"
    evidence.mkdir(parents=True, exist_ok=True)
    receipt_path = evidence / f"layer-{data['version']}-{data['mappingVersion']}.json"
    if receipt_path.exists():
        raise RuntimeError(f"A publication receipt already exists: {receipt_path}. Inspect it before retrying; no duplicate created.")
    receipt = {
        "status": "started", "datasetVersion": data["version"],
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "startedUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "organizationId": gis.properties.id,
    }

    def save() -> None:
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")

    save()
    try:
        stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d_%H%M%S")
        item = gis.content.create_service(
            name=f"FAS_Trade_Facts_{stamp}", capabilities="Query",
            item_properties={
                "title": "FAS Trade Facts - five partners - PRIVATE PROTOTYPE",
                "snippet": "Monthly U.S. agricultural trade value by BICO group for five partners. Unofficial prototype.",
                "description": f"<p>{LAYER_DESCRIPTION}</p><p>{' '.join(data['assumptions'])}</p>",
            },
            tags=["FAS", "prototype", "trade", "private"],
        )
        receipt.update(itemId=item.id, serviceUrl=item.url)
        save()
        if item.access != "private":
            raise RuntimeError("New service is not private; stop and review item access.")
        collection = FeatureLayerCollection.fromitem(item)
        result = collection.manager.add_to_definition({"layers": [{
            "id": 0, "name": "Trade facts", "type": "Feature Layer", "description": LAYER_DESCRIPTION,
            "geometryType": "esriGeometryPoint", "objectIdField": "OBJECTID", "displayField": "partner_name",
            "spatialReference": {"wkid": 4326}, "capabilities": "Query",
            "extent": {"xmin": -180, "ymin": -60, "xmax": 180, "ymax": 85, "spatialReference": {"wkid": 4326}},
            "fields": field_definitions(),
            "drawingInfo": {"renderer": {"type": "simple", "symbol": {
                "type": "esriSMS", "style": "esriSMSCircle", "size": 6, "color": [25, 111, 99, 160]}}},
        }]})
        if not result.get("success"):
            raise RuntimeError("Layer definition failed.")
        layer = FeatureLayerCollection.fromitem(gis.content.get(item.id)).layers[0]
        features = [{"attributes": a, "geometry": {
            "x": DISPLAY_POINTS[a["partner_code"]][0], "y": DISPLAY_POINTS[a["partner_code"]][1],
            "spatialReference": {"wkid": 4326}}} for a in rows]
        for start in range(0, len(features), 500):
            batch = layer.edit_features(adds=features[start:start + 500], rollback_on_failure=True)
            if any(not r.get("success") for r in batch.get("addResults", [])):
                raise RuntimeError(f"Hosted insert failed at row {start}; inspect the private item.")
        hosted = layer.query(where="1=1", out_fields="fact_key,value_usd", return_geometry=False,
                             result_record_count=100000).features
        actual = {f.attributes["fact_key"]: f.attributes["value_usd"] for f in hosted}
        expected = {a["fact_key"]: a["value_usd"] for a in rows}
        if set(actual) != set(expected):
            raise RuntimeError("Hosted keys do not match.")
        for key, value in expected.items():
            got = actual[key]
            if (value is None) != (got is None) or (value is not None and abs(got - value) > 0.5):
                raise RuntimeError(f"Hosted value mismatch for {key}.")
        refreshed = gis.content.get(item.id)
        if refreshed.access != "private":
            raise RuntimeError("Final item is not private.")
        anonymous_url = layer.url + "/query?where=1%3D1&returnCountOnly=true&f=json"
        if urlparse(anonymous_url).scheme != "https":
            raise RuntimeError("Expected HTTPS service.")
        with urlopen(anonymous_url, timeout=30) as response:
            anonymous = json.load(response)
        if anonymous.get("error", {}).get("code") not in (403, 499):
            raise RuntimeError("Unauthenticated query was not rejected as expected.")
        receipt.update(status="layer_verified_private", rowCount=len(hosted), layerUrl=layer.url)
        save()

        layer_item = gis.content.get(item.id)
        web_map_json = {
            "operationalLayers": [{
                "id": "trade-facts", "title": "Trade facts", "itemId": layer_item.id,
                "url": layer.url, "layerType": "ArcGISFeatureLayer", "visibility": True, "opacity": 1,
            }],
            "baseMap": {"title": "Light Gray Canvas", "baseMapLayers": [{
                "id": "gray", "layerType": "ArcGISTiledMapServiceLayer", "visibility": True, "opacity": 1,
                "url": "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer"}]},
            "spatialReference": {"wkid": 102100}, "version": "2.30", "authoringApp": "FAS Trade Explorer",
        }
        map_item = gis.content.add({
            "type": "Web Map", "title": f"FAS Trade Explorer web map {stamp} - PRIVATE PROTOTYPE",
            "snippet": "Web map for the FAS trade explorer assistant. Unofficial prototype.",
            "tags": ["FAS", "prototype", "private"], "text": json.dumps(web_map_json),
        })
        if map_item.access != "private":
            raise RuntimeError("Web map is not private; stop and review item access.")
        receipt.update(status="verified_private", webMapId=map_item.id,
                       finishedUtc=dt.datetime.now(dt.timezone.utc).isoformat())
        save()
        print(json.dumps(receipt, indent=2))
    except Exception:
        receipt["status"] = "failed_review_created_items_before_retry"
        save()
        raise


if __name__ == "__main__":
    main()
