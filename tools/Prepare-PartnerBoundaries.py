"""Prepare selected, public-domain Natural Earth display boundaries, not official borders."""

import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson"
ROOT = Path(__file__).resolve().parents[1]


def prepare(partners_path: Path, output: Path, source: Path | None = None):
    partners = json.loads(partners_path.read_text(encoding="utf-8"))
    if not partners or len({p["iso"] for p in partners}) != len(partners):
        raise ValueError("Expected unique selected partner ISO codes.")
    if source:
        raw = source.read_bytes()
    else:
        with urlopen(URL, timeout=60) as response:
            raw = response.read()
    countries = json.loads(raw)
    features = []
    for partner in partners:
        matches = [f for f in countries["features"] if f["properties"]["ISO_A2_EH"] == partner["iso"]]
        if len(matches) != 1 or matches[0]["geometry"]["type"] not in ("Polygon", "MultiPolygon"):
            raise ValueError(f"No unique polygon boundary for {partner['name']}.")
        features.append({
            "type": "Feature",
            "properties": {"ISO": partner["iso"], "COUNTRY": partner["name"]},
            "geometry": matches[0]["geometry"],
        })
    payload = {
        "type": "FeatureCollection",
        "source": {"url": URL, "sha256": hashlib.sha256(raw).hexdigest(),
                   "license": "Natural Earth public domain", "scale": "1:110m",
                   "note": "Generalized display context only; not authoritative borders or a political statement."},
        "features": features,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(output)
    print(f"Prepared {len(features)} selected partner boundaries: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--partners", type=Path, default=ROOT / "prototype" / "partners.json")
    parser.add_argument("--output", type=Path, default=ROOT / "public" / "partner-boundaries.geojson")
    parser.add_argument("--source", type=Path, help="Use a saved Natural Earth GeoJSON instead of downloading.")
    args = parser.parse_args()
    prepare(args.partners, args.output, args.source)
