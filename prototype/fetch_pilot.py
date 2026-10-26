"""Fetch selected GATS partners, preserving raw evidence and resumable progress."""

import hashlib
import json
import os
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

PARTNERS = [
    {"code": "CA", "name": "Canada", "iso": "CA"},
    {"code": "MX", "name": "Mexico", "iso": "MX"},
    {"code": "BR", "name": "Brazil", "iso": "BR"},
    {"code": "JA", "name": "Japan", "iso": "JP"},
    {"code": "CH", "name": "China", "iso": "CN"},
]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Unexpected redirect from FAS; credentials will not be forwarded.")


def load_partners(path: Path | None) -> list[dict]:
    partners = json.loads(path.read_text(encoding="utf-8")) if path else PARTNERS
    if not isinstance(partners, list) or not partners:
        raise ValueError("Partner configuration must be a nonempty array.")
    for partner in partners:
        if set(partner) != {"code", "name", "iso"} or not all(isinstance(value, str) and value for value in partner.values()):
            raise ValueError("Each partner requires code, name and ISO alpha-2 strings.")
        if len(partner["code"]) != 2 or not partner["code"].isalnum() or len(partner["iso"]) != 2 or not partner["iso"].isalpha():
            raise ValueError("Partner and ISO codes must be two characters.")
    for field in ("code", "iso"):
        if len({p[field] for p in partners}) != len(partners):
            raise ValueError(f"Duplicate partner {field}.")
    return partners


def fetch(output: Path, partners_path: Path | None = None, source: Path | None = None, resume: Path | None = None) -> None:
    key = os.environ.get("FAS_API_KEY")
    if not key:
        raise ValueError("FAS_API_KEY is missing. Use tools\\Invoke-FasPilot.ps1.")
    partners = load_partners(partners_path)
    started = datetime.now(timezone.utc)
    directory = resume or Path(os.environ["LOCALAPPDATA"]) / "FasTradeExplorer" / "pilot" / started.strftime("%Y%m%dT%H%M%S%fZ")
    directory.mkdir(parents=True, exist_ok=bool(resume))
    manifest: dict = {
        "status": "in_progress", "startedUtc": started.isoformat(),
        "apiBase": "https://api.fas.usda.gov/api/", "requests": [], "partners": partners,
        "selectionBasis": "Informed selection of individual partners; not a computed top-20 or worldwide ranking.",
    }
    if resume:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        if manifest["partners"] != partners or manifest["apiBase"] != "https://api.fas.usda.gov/api/":
            raise ValueError("Resume configuration differs from the saved collection.")
        manifest["status"] = "in_progress"
    source_manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8-sig")) if source else None
    if source_manifest and manifest.get("months") and manifest["months"] != source_manifest["months"]:
        raise ValueError("Source reporting window differs from the collection being resumed.")
    source_requests = {item["file"]: item for item in source_manifest["requests"]} if source_manifest else {}
    print(f"Collection directory (use --resume if interrupted): {directory}", flush=True)
    opener = build_opener(NoRedirect())
    manifest_lock = RLock()

    def save_manifest():
        with manifest_lock:
            temporary = directory / "manifest.tmp"
            temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
            temporary.replace(directory / "manifest.json")

    def get(route: str, filename: str) -> list[dict]:
        url = manifest["apiBase"] + route
        previous = next((item for item in manifest["requests"] if item["file"] == filename), None)
        cached = previous
        if not cached and filename.startswith(("censusImports-", "censusExports-")):
            cached = source_requests.get(filename)
        if cached:
            cached_path = directory / filename if previous else source / filename
            raw = cached_path.read_bytes()
            if cached["url"] != url or hashlib.sha256(raw).hexdigest().upper() != cached["sha256"].upper():
                raise ValueError(f"Cached source integrity check failed: {filename}")
            records = json.loads(raw)
            if not isinstance(records, list) or len(records) != cached["recordCount"]:
                raise ValueError(f"Invalid cached source records: {filename}")
            if not previous:
                shutil.copyfile(cached_path, directory / filename)
                with manifest_lock:
                    manifest["requests"].append(cached)
                    save_manifest()
            return records
        for attempt in range(3):
            try:
                request = Request(url, headers={"X-Api-Key": key, "Accept": "application/json"})
                with opener.open(request, timeout=60) as response:
                    raw = response.read()
                break
            except HTTPError as error:
                if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise RuntimeError(f"FAS HTTP {error.code} for {route}; collection stopped.") from None
                retry = error.headers.get("Retry-After", "")
                if retry.isdigit() and int(retry) > 60:
                    raise RuntimeError("FAS requested a longer cooldown; retry this collection later.") from None
                wait = max(2 ** (attempt + 1), int(retry) if retry.isdigit() else 0)
                print(f"FAS HTTP {error.code}; retrying {route} in {wait}s.", flush=True)
                time.sleep(wait)
            except URLError:
                raise RuntimeError(f"Network failure for {route}; collection stopped.") from None
        else:
            raise RuntimeError("FAS retry limit reached.")
        records = json.loads(raw)
        if not isinstance(records, list):
            raise ValueError(f"Expected array from {route}")
        (directory / filename).write_bytes(raw)
        with manifest_lock:
            manifest["requests"].append({
                "url": url, "file": filename, "recordCount": len(records), "httpStatus": 200,
                "retrievedUtc": datetime.now(timezone.utc).isoformat(),
                "sha256": hashlib.sha256(raw).hexdigest().upper(),
            })
            save_manifest()
        return records

    try:
        countries = get("gats/countries", "countries.json")
        for partner in partners:
            matches = [r for r in countries if r["countryCode"] == partner["code"] and r["countryName"] == partner["name"]
                       and not r.get("discontinuedOn")]
            if len(matches) != 1:
                raise ValueError(f"Partner code/name not verified: {partner['name']}")
        exports = get("gats/census/data/exports/dataReleaseDates", "export-releases.json")
        imports = get("gats/census/data/imports/dataReleaseDates", "import-releases.json")

        def released(rows: list[dict]) -> set[str]:
            return {
                r["statisticalYearMonth"] for r in rows
                if r["reporterCode"] == "US"
                and datetime.fromisoformat(r["releaseTimeStamp"]).date() <= started.date()
            }

        common = released(exports) & released(imports)
        if not common:
            raise ValueError("No common released month.")
        latest = datetime.strptime(max(common), "%Y%m")
        if (latest.year, latest.month) >= (started.year, started.month):
            raise ValueError("Latest reporting month is not complete.")
        months = []
        for offset in range(11, -1, -1):
            ordinal = latest.year * 12 + latest.month - 1 - offset
            year, month = divmod(ordinal, 12)
            months.append(f"{year:04}{month + 1:02}")
        if not set(months) <= common:
            raise ValueError("Common release window is not contiguous.")
        fixed_months = source_manifest["months"] if source_manifest else manifest.get("months")
        if fixed_months:
            if not set(fixed_months) <= common:
                raise ValueError("Requested reporting window is not fully released for both directions.")
            months = fixed_months
        manifest["months"] = months
        save_manifest()
        def collect(job):
            partner, flow, month = job
            route = f"gats/{flow}/partnerCode/{partner['code']}/year/{month[:4]}/month/{month[4:]}"
            records = get(route, f"{flow}-{partner['code']}-{month}.json")
            print(f"{partner['name']} {flow} {month}: {len(records)} source rows", flush=True)
            time.sleep(0.2)

        jobs = [(partner, flow, month) for partner in partners
                for flow in ("censusImports", "censusExports") for month in months]
        # Small batches bound requests still in flight if a source or rate-limit error stops collection.
        with ThreadPoolExecutor(max_workers=3) as pool:
            for offset in range(0, len(jobs), 3):
                list(pool.map(collect, jobs[offset:offset + 3]))
        manifest["status"] = "collected_semantic_gates_open"
    except Exception:
        manifest["status"] = "failed"
        raise
    finally:
        save_manifest()
    print(f"Raw evidence: {directory}", flush=True)
    from prepare_sample import prepare
    prepare(directory, output)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("public") / "prototype-data.json")
    parser.add_argument("--partners", type=Path, help="JSON array of selected partners.")
    parser.add_argument("--source", type=Path, help="Reuse verified raw country/month files and its exact reporting window.")
    parser.add_argument("--resume", type=Path, help="Resume a saved collection directory.")
    args = parser.parse_args()
    fetch(args.output, args.partners, args.source, args.resume)
