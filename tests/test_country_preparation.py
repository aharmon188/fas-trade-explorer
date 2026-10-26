import hashlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "prototype"))
import fetch_pilot
from prepare_sample import load_catalog, prepare

spec = importlib.util.spec_from_file_location("partner_boundaries", ROOT / "tools" / "Prepare-PartnerBoundaries.py")
boundaries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundaries)

MONTHS = ["202509", "202510", "202511", "202512", "202601", "202602",
          "202603", "202604", "202605", "202606", "202607", "202608"]


def write_source(directory):
    directory.mkdir()
    commodities, targets = load_catalog()
    requests = []
    for flow, direction in [("censusExports", "exports"), ("censusImports", "imports")]:
        hs10 = next(code for code, ids in targets[direction].items() if "wheat" in ids)
        for month in MONTHS:
            filename = f"{flow}-CA-{month}.json"
            raw = json.dumps([{"hS10Code": hs10, "countryCode": "CA", "date": month,
                               "value": 100, "quantity1": 1000, "censusUOMId1": 47}]).encode()
            (directory / filename).write_bytes(raw)
            requests.append({"file": filename, "recordCount": 1,
                             "url": f"https://api.fas.usda.gov/api/gats/{flow}/partnerCode/CA/year/{month[:4]}/month/{month[4:]}",
                             "sha256": hashlib.sha256(raw).hexdigest().upper()})
    manifest = {"startedUtc": "2026-10-26T00:00:00+00:00", "months": MONTHS,
                "partners": fetch_pilot.PARTNERS[:1], "requests": requests}
    (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return manifest, commodities


class CountryPreparationTests(unittest.TestCase):
    def test_selected_configuration_has_twenty_unique_active_codes(self):
        partners = fetch_pilot.load_partners(ROOT / "prototype" / "partners.json")
        self.assertEqual(len(partners), 20)
        self.assertEqual({p["code"] for p in partners if p["name"] in ["France", "Italy", "Australia"]}, {"F1", "I1", "A2"})
        self.assertEqual(len({p["iso"] for p in partners}), 20)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "partners.json"
            path.write_text(json.dumps([partners[0], partners[0]]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                fetch_pilot.load_partners(path)

    def test_preparation_keeps_period_unknowns_and_rollups_separate(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source"
            _, commodities = write_source(source)
            output = Path(temp) / "output.json"
            with redirect_stdout(io.StringIO()):
                prepare(source, output)
            data = json.loads(output.read_text())
            self.assertEqual(data["months"], MONTHS)
            expected = 12 * sum(len(c["directions"]) for c in commodities)
            self.assertEqual(len(data["records"]), expected)
            wheat = [r for r in data["records"] if r["commodityId"] == "wheat"]
            self.assertTrue(all(r["valueUsd"] == 100 for r in wheat))
            bulk = [r for r in data["records"] if r["commodityId"] == "all-bulk"]
            self.assertTrue(all(r["valueUsd"] == 100 for r in bulk))
            absent = [r for r in data["records"] if r["commodityId"] == "corn"]
            self.assertTrue(all(r["valueUsd"] is None for r in absent))
            old = output.read_bytes()
            (source / "censusExports-CA-202509.json").write_text("[]")
            with self.assertRaisesRegex(ValueError, "integrity"):
                prepare(source, output)
            self.assertEqual(output.read_bytes(), old)

    def test_collection_reuses_verified_source_and_resumes_without_losing_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            write_source(source)
            config = root / "partners.json"
            config.write_text(json.dumps(fetch_pilot.PARTNERS[:1]))
            output = root / "output.json"
            output.write_text("previous dataset")

            class Opener:
                def __init__(self, fail=False):
                    self.fail = fail
                    self.routes = []

                def open(self, request, timeout):
                    self.routes.append(request.full_url)
                    if request.full_url.endswith("gats/countries"):
                        rows = [{"countryCode": "CA", "countryName": "Canada", "discontinuedOn": None}]
                    elif self.fail:
                        raise URLError("test interruption")
                    else:
                        rows = [{"reporterCode": "US", "statisticalYearMonth": month,
                                 "releaseTimeStamp": "2025-01-01T00:00:00"} for month in MONTHS]
                    return io.BytesIO(json.dumps(rows).encode())

            with patch.dict(os.environ, {"LOCALAPPDATA": str(root), "FAS_API_KEY": "offline-test"}), \
                    patch.object(fetch_pilot.time, "sleep"), redirect_stdout(io.StringIO()):
                with patch.object(fetch_pilot, "build_opener", return_value=Opener(fail=True)):
                    with self.assertRaisesRegex(RuntimeError, "Network failure"):
                        fetch_pilot.fetch(output, config, source)
                self.assertEqual(output.read_text(), "previous dataset")
                directory = next((root / "FasTradeExplorer" / "pilot").iterdir())
                self.assertEqual(json.loads((directory / "manifest.json").read_text())["status"], "failed")
                opener = Opener()
                with patch.object(fetch_pilot, "build_opener", return_value=opener):
                    fetch_pilot.fetch(output, config, source, directory)
                data = json.loads(output.read_text())
                self.assertEqual(data["months"], MONTHS)
                self.assertEqual(len(data["partners"]), 1)
                self.assertEqual(len(opener.routes), 2, "Saved country metadata and 24 raw country files must be reused")
                manifest = json.loads((directory / "manifest.json").read_text())
                self.assertEqual(len(manifest["requests"]), 27)
                self.assertEqual(manifest["status"], "collected_semantic_gates_open")

    def test_local_boundaries_cover_the_configured_partners_exactly(self):
        partners = fetch_pilot.load_partners(ROOT / "prototype" / "partners.json")
        data = json.loads((ROOT / "public" / "partner-boundaries.geojson").read_text())
        self.assertEqual({f["properties"]["ISO"] for f in data["features"]}, {p["iso"] for p in partners})
        self.assertEqual(len(data["features"]), len(partners))
        self.assertTrue(all(f["geometry"]["type"] in ("Polygon", "MultiPolygon") for f in data["features"]))
        self.assertEqual(data["source"]["license"], "Natural Earth public domain")


if __name__ == "__main__":
    unittest.main()
