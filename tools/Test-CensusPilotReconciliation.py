"""Reconcile every BICO group in the pilot against Census HS10 values. Read-only.

Membership comes from the GATS crosswalks (prototype/bico-crosswalk-*.json), not
from HS prefixes. Exports are compared with Census domestic (DF=1); imports with
general imports (GEN_VAL_MO). Category rollups are skipped: they are sums of groups.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "prototype-data.json")
CENSUS_COUNTRY = {"CA": "1220", "MX": "2010", "BR": "3510", "JA": "5880", "CH": "5700"}
BASE = "https://api.census.gov/data/timeseries/intltrade/"


def fetch(job):
    direction, partner, month, key = job
    code = "E_COMMODITY" if direction == "exports" else "I_COMMODITY"
    measures = "DF,ALL_VAL_MO" if direction == "exports" else "GEN_VAL_MO"
    query = {"get": f"{code},{measures}", "COMM_LVL": "HS10", "CTY_CODE": CENSUS_COUNTRY[partner],
             "time": f"{month[:4]}-{month[4:]}", "key": key}
    url = f"{BASE}{direction}/hs?" + urllib.parse.urlencode(query)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=180) as response:
                body = response.read().decode()
            rows = json.loads(body) if body.strip() else []
            header = rows[0] if rows else []
            totals = defaultdict(float)
            for row in rows[1:]:
                item = dict(zip(header, row))
                if direction == "exports":
                    if item["DF"] == "1":
                        totals[item[code]] += float(item["ALL_VAL_MO"])
                else:
                    totals[item[code]] += float(item["GEN_VAL_MO"])
            return job[:3], dict(totals)
        except urllib.error.HTTPError as error:
            sys.exit(f"Census HTTP {error.code}: {error.read().decode()[:200]}")
        except OSError:
            if attempt == 2:
                raise


def main():
    key = os.environ.get("CENSUS_API_KEY")
    if not key:
        sys.exit("CENSUS_API_KEY is not set; run tools\\Invoke-CensusPilotReconciliation.ps1.")
    with open(DATA, encoding="utf-8") as handle:
        pilot = json.load(handle)
    members = defaultdict(set)
    for direction in ("exports", "imports"):
        with open(os.path.join(ROOT, "prototype", f"bico-crosswalk-{direction}.json"), encoding="utf-8") as handle:
            for member in json.load(handle)["members"]:
                members[(direction, member["bicoCode"])].add(member["hs10"])
    kinds = {c["id"]: c["kind"] for c in pilot["commodities"]}
    gats = [r for r in pilot["records"] if r["status"] == "observed" and kinds[r["commodityId"]] == "group"]
    jobs = sorted({(r["direction"], r["partnerCode"], r["month"], key) for r in gats})
    with ThreadPoolExecutor(max_workers=4) as pool:
        census = dict(pool.map(fetch, jobs))

    summary = defaultdict(lambda: defaultdict(int))
    misses = []
    for record in gats:
        direction, partner, month = record["direction"], record["partnerCode"], record["month"]
        codes = members[(direction, record["bicoCode"])]
        by_code = census[(direction, partner, month)]
        expected = sum(by_code.get(code, 0.0) for code in codes)
        group = summary[direction]
        group["cells"] += 1
        if abs(expected - record["valueUsd"]) < 1:
            group["exact"] += 1
        elif record["valueUsd"] and abs(expected - record["valueUsd"]) / record["valueUsd"] <= 0.01:
            group["within1pct"] += 1
        else:
            group["off"] += 1
            misses.append((direction, partner, record["commodityId"], month, record["valueUsd"], round(expected)))
    for direction, group in sorted(summary.items()):
        print(direction, dict(group))
    print("\nCells off by more than 1% (first 40):")
    for miss in misses[:40]:
        print(miss)


main()
