"""Prepare the local pilot dataset (every BICO group) from saved FAS data and the official BICO crosswalks."""

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIRECTIONS = ("exports", "imports")
CROSSWALKS = {d: ROOT / f"bico-crosswalk-{d}.json" for d in DIRECTIONS}
MAPPING_VERSION = "gats-bico-crosswalk-2026-10-26"
MASS_UNITS = {47: Decimal(1000), 70: Decimal(1)}  # KG, MT; divisor to metric tons

# Top-level BICO category names differ by direction.
CATEGORIES = {
    "Bulk Total": ("bulk", "Bulk", 0),
    "Intermediate Total": ("intermediate", "Intermediate", 1),
    "Consumer Oriented Total": ("consumer-oriented", "Consumer-Oriented", 2),
    "Consumer-Oriented": ("consumer-oriented", "Consumer-Oriented", 2),
    "Agricultural Related Products": ("agricultural-related", "Agricultural & Related", 3),
    "Agricultural & Related": ("agricultural-related", "Agricultural & Related", 3),
}
NOTES = {
    ("corn", "exports"): "Imports have no Corn group; see Coarse Grains for imports, which is broader.",
    ("soybeans", "exports"): "Imports have no Soybeans group; see Oilseeds for imports, which is broader.",
    ("coarse-grains", "imports"): "Includes corn and other coarse grains. The official import list has no separate Corn group.",
    ("oilseeds", "imports"): "Includes soybeans and other oilseeds. The official import list has no separate Soybeans group.",
    ("rice", "exports"): "Quantities are reported mass, not milled-equivalent weight.",
    ("rice", "imports"): "Quantities are reported mass, not milled-equivalent weight.",
}


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower().replace("&", "and")).strip("-")


def load_catalog():
    """Returns (commodities, code_targets). code_targets[direction][hs10] = [commodity ids to credit]."""
    commodities = {}
    code_targets = {}
    counts = {}
    for direction, path in CROSSWALKS.items():
        data = json.loads(path.read_text(encoding="utf-8"))
        groups = {}
        for group in data["groups"]:
            groups[group["code"]] = group
        targets = code_targets[direction] = {}
        for category_name in {m["topLevel"] for m in data["members"]}:
            cid, label, order = CATEGORIES[category_name]
            top = next(g for g in data["groups"] if "." not in g["path"] and g["name"] == category_name)
            entry = commodities.setdefault(f"all-{cid}", {
                "id": f"all-{cid}", "name": f"All {label}", "kind": "category",
                "category": label, "order": (order, -1), "groups": {}})
            entry["groups"][direction] = {"bicoCode": top["code"], "bicoName": category_name, "category": label}
        for member in data["members"]:
            cid, label, order = CATEGORIES[member["topLevel"]]
            group = groups[member["bicoCode"]]
            commodity_id = slug(group["name"])
            sequence = tuple(int(part) for part in group["path"].split("."))
            entry = commodities.setdefault(commodity_id, {
                "id": commodity_id, "name": group["name"], "kind": "group",
                "category": label, "order": (order, *sequence), "groups": {}})
            existing = entry["groups"].get(direction)
            if existing and existing["bicoCode"] != member["bicoCode"]:
                raise ValueError(f"Two {direction} groups share the id {commodity_id}")
            entry["groups"][direction] = {"bicoCode": member["bicoCode"], "bicoName": group["name"], "category": label}
            if member["hs10"] in targets:
                raise ValueError(f"HS10 {member['hs10']} appears twice in the {direction} crosswalk")
            targets[member["hs10"]] = [commodity_id, f"all-{cid}"]
            for key in (commodity_id, f"all-{cid}"):
                counts[(key, direction)] = counts.get((key, direction), 0) + 1
    result = []
    for entry in sorted(commodities.values(), key=lambda e: e["order"]):
        lines = []
        for direction, group in entry["groups"].items():
            group["memberCount"] = counts[(entry["id"], direction)]
            note = NOTES.get((entry["id"], direction), "")
            what = "All HS10 codes in the category" if entry["kind"] == "category" else "BICO group"
            group["description"] = (f'{what} {group["bicoCode"]} "{group["bicoName"]}" ({direction}): '
                                    f'{group["memberCount"]} HS10 codes. {note}').strip()
            lines.append(group["description"])
        entry["directions"] = list(entry["groups"])
        entry["description"] = " ".join(lines)
        del entry["order"]
        result.append(entry)
    return result, code_targets


def prepare(source: Path, output: Path) -> None:
    commodities, code_targets = load_catalog()
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8-sig"))
    months = manifest["months"]
    if len(months) != 12 or len(set(months)) != 12:
        raise ValueError("Expected twelve distinct reporting months.")
    parsed_months = [datetime.strptime(month, "%Y%m") for month in months]
    ordinals = [date.year * 12 + date.month for date in parsed_months]
    if ordinals != list(range(ordinals[0], ordinals[0] + 12)):
        raise ValueError("Reporting months must be consecutive and ordered.")
    partners = manifest.get("partners", [{"code": "CA", "name": "Canada", "iso": "CA"}])
    requests = {item["file"]: item for item in manifest["requests"]}
    result = []
    for partner in partners:
        for endpoint in ("censusImports", "censusExports"):
            direction = "imports" if endpoint == "censusImports" else "exports"
            for month in months:
                name = (f"{endpoint}-{partner['code']}-{month}.json" if "partners" in manifest
                        else f"{endpoint}-{month}.json")
                raw = (source / name).read_bytes()
                if hashlib.sha256(raw).hexdigest().upper() != requests[name]["sha256"]:
                    raise ValueError(f"Source integrity check failed: {name}")
                rows = json.loads(raw, parse_float=Decimal)
                seen = set()
                totals = {}
                for row in rows:
                    code = row["hS10Code"].strip()
                    if row["countryCode"] != partner["code"] or row["date"] != month:
                        raise ValueError(f"Unexpected country or date in {name}")
                    if len(code) != 10 or not code.isdigit() or code in seen:
                        raise ValueError(f"Invalid or duplicate HS10 in {name}: {code}")
                    seen.add(code)
                    targets = code_targets[direction].get(code)
                    if not targets:
                        continue
                    reported_value = Decimal(row["value"])
                    reported_quantity = Decimal(row["quantity1"])
                    if not reported_value.is_finite() or not reported_quantity.is_finite():
                        raise ValueError(f"Nonfinite measure in {name}")
                    if reported_value < 0 or reported_quantity < 0:
                        raise ValueError(f"Negative measure requires review: {name}")
                    divisor = MASS_UNITS.get(row["censusUOMId1"])
                    for target in targets:
                        cell = totals.setdefault(target, {"value": Decimal(0), "quantity": Decimal(0), "mass": True, "count": 0})
                        cell["value"] += reported_value
                        cell["count"] += 1
                        if divisor is None:
                            cell["mass"] = False
                        else:
                            cell["quantity"] += reported_quantity / divisor
                for commodity in commodities:
                    group = commodity["groups"].get(direction)
                    if not group:
                        continue
                    cell = totals.get(commodity["id"])
                    if cell and cell["value"] != cell["value"].to_integral_value():
                        raise ValueError("Expected whole-dollar source values.")
                    has_quantity = bool(cell) and cell["mass"] and commodity["kind"] == "group"
                    result.append({
                        "partnerCode": partner["code"], "commodityId": commodity["id"],
                        "mappingVersion": MAPPING_VERSION, "month": month, "direction": direction,
                        "bicoCode": group["bicoCode"],
                        "valueUsd": int(cell["value"]) if cell else None,
                        "quantityMt": round(float(cell["quantity"]), 3) if has_quantity else None,
                        "status": "observed" if cell else "no_reported_rows",
                        "includedCount": cell["count"] if cell else 0,
                        "sourceUrl": requests[name]["url"],
                    })
    payload = {
        "prototype": True, "partners": partners, "commodities": commodities,
        "mappingVersion": MAPPING_VERSION, "months": months,
        "retrievedUtc": manifest["startedUtc"],
        "generatedUtc": datetime.now(timezone.utc).isoformat(),
        "version": source.name,
        "selectionBasis": manifest.get("selectionBasis", "Selected pilot partners; not a worldwide ranking."),
        "crosswalkSha256": {d: hashlib.sha256(p.read_bytes()).hexdigest() for d, p in CROSSWALKS.items()},
        "assumptions": [
            "Commodity groups use GATS BICO-HS10 reports (exports: Schedule B; imports: HTS general) downloaded 2026-10-26, assumed to apply to the whole window. Whether membership changed across years is unconfirmed.",
            "BICO group codes and names differ by direction. Imports have no Corn or Soybeans group (Coarse Grains and Oilseeds are broader).",
            "Export values equal Census domestic exports and import values equal Census general imports (reconciled for the four-commodity pilot on 2026-10-26). Value is customs value, not CIF or duty.",
            "Quantities are converted to metric tons only when every included HS10 line is reported in kg or metric tons; otherwise they are unavailable. Never sum quantities across commodities. Absent rows remain unknown, not zero.",
            "Explicit pilot partners only; rankings are within this selected set, not worldwide.",
        ],
        "records": result,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, indent=1, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(output)
    print(f"Prepared {len(result)} monthly facts for {len(commodities)} commodities at {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path("public") / "prototype-data.json")
    arguments = parser.parse_args()
    prepare(arguments.source, arguments.output)
