"""Compare Census DOM/FOR/ALL export values for Canada wheat (HS 1001, excluding
seed 1001910000) with the GATS Canada Wheat export report. Read-only."""
import csv
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

GATS_CSV = os.path.join(os.environ["USERPROFILE"], "Downloads", "Standard Query_06667.csv")
EXCLUDED = {"1001910000"}
MONTHS = [f"2025-{m:02d}" for m in range(9, 13)] + [f"2026-{m:02d}" for m in range(1, 9)]


def load_gats():
    result = {}
    with open(GATS_CSV, newline="", encoding="utf-8-sig") as handle:
        for row in csv.reader(handle):
            if len(row) > 6 and row[3] == "Wheat" and row[4][:4].isdigit():
                year = row[4][:4]
                for month in range(1, 13):
                    cell = row[6 + (month - 1) * 2].replace(",", "")
                    if cell:
                        result[f"{year}-{month:02d}"] = float(cell)
    return result


def census(month, key):
    query = {
        "get": "E_COMMODITY,DF,ALL_VAL_MO",
        "COMM_LVL": "HS10",
        "E_COMMODITY": "1001*",
        "CTY_CODE": "1220",
        "time": month,
        "key": key,
    }
    url = "https://api.census.gov/data/timeseries/intltrade/exports/hs?" + urllib.parse.urlencode(query)
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            body = response.read().decode()
    except urllib.error.HTTPError as error:
        sys.exit(f"Census HTTP {error.code} for {month}: {error.read().decode()[:300]}")
    return json.loads(body) if body.strip() else []


def main():
    key = os.environ.get("CENSUS_API_KEY")
    if not key:
        sys.exit("CENSUS_API_KEY is not set; run tools\\Invoke-CensusExportTest.ps1.")
    gats = load_gats()
    print(f"{'month':8} {'GATS':>12} {'DOM':>12} {'FOR':>12} {'ALL':>12} {'ALL=DOM+FOR':>12} {'DOM%':>7} {'ALL%':>7}")
    for month in MONTHS:
        rows = census(month, key)
        totals = defaultdict(float)
        for row in rows[1:]:
            record = dict(zip(rows[0], row))
            if record["E_COMMODITY"] in EXCLUDED:
                continue
            totals[record["DF"]] += float(record["ALL_VAL_MO"])
        if month == MONTHS[0]:
            print("DF codes returned:", sorted(totals))
        print_codes = month == MONTHS[0]
        dom, foreign, total = totals.get("1", 0.0), totals.get("2", 0.0), totals.get("-", 0.0)
        if print_codes:
            print("DF totals:", dict(totals))
        reference = gats.get(month)
        pct = lambda value: f"{(value - reference) / reference * 100:7.2f}" if reference else "    n/a"
        print(f"{month:8} {reference or 0:12,.0f} {dom:12,.0f} {foreign:12,.0f} {total:12,.0f} "
              f"{str(abs(total - dom - foreign) < 1):>12} {pct(dom)} {pct(total)}")


main()
