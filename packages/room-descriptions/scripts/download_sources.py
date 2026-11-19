"""Download versioned build inputs; runtime never imports this script.

GeoNames is a rolling dump: freeze the downloaded bytes and manifest together.
OSMNames v2.0.4 is an older snapshot, not current OSM. A recent locally extracted
OSM PBF/JSONL can replace it using the same normalizer and build pipeline.
"""

import argparse
import hashlib
import json
import shutil
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/"
SOURCES = {
    "cities1000.zip": (
        "https://download.geonames.org/export/dump/cities1000.zip",
        "GeoNames rolling cities1000",
    ),
    "osmnames-v2.0.4.tsv.gz": (
        "https://github.com/OSMNames/OSMNames/releases/download/v2.0.4/planet-latest_geonames.tsv.gz",
        "OSMNames v2.0.4",
    ),
    "countries.geojson": (
        BASE + "ne_110m_admin_0_countries.geojson",
        "Natural Earth v5.1.2 countries 110m",
    ),
    "states.geojson": (
        BASE + "ne_10m_admin_1_states_provinces.geojson",
        "Natural Earth v5.1.2 states 10m",
    ),
    "regions.geojson": (
        BASE + "ne_10m_geography_regions_polys.geojson",
        "Natural Earth v5.1.2 regions 10m",
    ),
    "oceans.geojson": (
        BASE + "ne_10m_geography_marine_polys.geojson",
        "Natural Earth v5.1.2 marine 10m",
    ),
}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("directory", type=Path)
    p.add_argument("--only", nargs="*", choices=list(SOURCES))
    a = p.parse_args()
    a.directory.mkdir(parents=True, exist_ok=True)
    manifest_path = a.directory / "sources.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for name, (url, version) in SOURCES.items():
        if a.only and name not in a.only:
            continue
        target = a.directory / name
        if not target.exists():
            print("Downloading " + name, flush=True)
            temporary = target.with_suffix(target.suffix + ".part")
            request = urllib.request.Request(
                url, headers={"User-Agent": "GeoChalk-offline-gazetteer/1.0"}
            )
            with (
                urllib.request.urlopen(request, timeout=120) as response,
                temporary.open("wb") as out,
            ):
                shutil.copyfileobj(response, out, length=1024 * 1024)
            temporary.replace(target)
        with target.open("rb") as downloaded:
            digest = hashlib.file_digest(downloaded, "sha256").hexdigest()
        if name in manifest and manifest[name]["sha256"] != digest:
            raise ValueError("cached source checksum changed: " + name)
        manifest[name] = {
            "url": url,
            "version": version,
            "sha256": digest,
            "bytes": target.stat().st_size,
            "downloaded_at": manifest.get(name, {}).get(
                "downloaded_at", datetime.now(UTC).isoformat()
            ),
        }
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        print(name + ": " + str(target.stat().st_size) + " bytes", flush=True)


if __name__ == "__main__":
    main()
