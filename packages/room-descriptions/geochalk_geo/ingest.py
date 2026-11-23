"""Normalize source files to reproducible JSONL; never used by the runtime."""

import argparse
import csv
import gzip
import io
import json
import zipfile
from pathlib import Path

from .build import COARSE, validate_record

OSM_TYPES = {"city", "town", "village", "suburb", "quarter", "neighbourhood"}


def population(value):
    try:
        return max(0, int(str(value).replace(",", "").replace(" ", "")))
    except (ValueError, TypeError):
        return None


def text_file(path):
    return (
        gzip.open(path, "rt", encoding="utf8", newline="")
        if str(path).endswith(".gz")
        else open(path, encoding="utf8", newline="")
    )


def geonames(path):
    with zipfile.ZipFile(path) as archive:
        names = [
            n
            for n in archive.namelist()
            if n.endswith(".txt") and "readme" not in n.lower()
        ]
        if len(names) != 1:
            raise ValueError("expected one GeoNames data file")
        with archive.open(names[0]) as raw:
            for row in csv.reader(
                io.TextIOWrapper(raw, encoding="utf8"), delimiter="\t"
            ):
                if len(row) < 19:
                    raise ValueError("invalid GeoNames row")
                if row[6] != "P":
                    continue
                pop = population(row[14])
                kind = (
                    "neighbourhood"
                    if row[7] == "PPLX"
                    else (
                        "city"
                        if (pop or 0) >= 100000 or row[7] == "PPLC"
                        else "town" if (pop or 0) >= 10000 else "village"
                    )
                )
                yield {
                    "source": "geonames",
                    "source_id": row[0],
                    "name": row[1],
                    "latitude": float(row[4]),
                    "longitude": float(row[5]),
                    "population": pop,
                    "kind": kind,
                    "prominence": 1.0 if row[7] == "PPLC" else 0.0,
                    "country": row[8],
                    "feature_code": row[7],
                    "modified": row[18],
                    "aliases": row[3].split(",") if row[3] else [],
                }


def osmnames(path):
    # Avoid loading the 20M street rows: filter their types before creating records.
    with text_file(path) as f:
        header = f.readline().rstrip("\r\n").split("\t")
        columns = {name: i for i, name in enumerate(header)}
        required = {"name", "osm_type", "osm_id", "type", "lon", "lat", "importance"}
        if not required <= columns.keys():
            raise ValueError(f"OSMNames missing columns: {required - columns.keys()}")
        for line in f:
            # Most rows are streets, some with huge housenumber fields. Inspect
            # the type before splitting the rest of the line; no CSV field cap.
            head = line.split("\t", columns["type"] + 1)
            if len(head) <= columns["type"]:
                raise ValueError("invalid OSMNames TSV row")
            if head[columns["type"]] not in OSM_TYPES:
                continue
            row = line.rstrip("\r\n").split("\t")
            if len(row) != len(header):
                raise ValueError("invalid OSMNames TSV row width")
            get = lambda key, default="", row=row: (
                row[columns[key]] if key in columns else default
            )
            if not get("name").strip():
                continue
            yield {
                "source": "osm",
                "source_id": f"{get('osm_type')}:{get('osm_id')}",
                "name": get("name"),
                "latitude": float(get("lat")),
                "longitude": float(get("lon")),
                "kind": get("type"),
                "population": population(get("population")),
                "prominence": min(1, max(0, float(get("importance") or 0))),
                "country": get("country_code"),
                "wikidata": get("wikidata"),
                "aliases": get("alternative_names").split(","),
            }


def osm_jsonl(path):
    """OSM/Overpass-derived JSONL: tags + id/type + lat/lon or center.

    Ways/relations require a representative center supplied by the extractor.
    Geoapify locality JSONL (location=[lon,lat]) is also accepted.
    """
    with text_file(path) as f:
        for line in f:
            r = json.loads(line)
            tags = r.get("tags", r)
            kind = tags.get("place", r.get("type"))
            if kind not in OSM_TYPES:
                continue
            name = tags.get("name:en") or tags.get("name")
            if not name:
                continue
            location = r.get("center", r)
            lat, lon = (
                (r["location"][1], r["location"][0])
                if "location" in r
                else (location["lat"], location["lon"])
            )
            yield {
                "source": "osm",
                "source_id": f"{r.get('osm_type', r.get('type', 'node'))}:{r.get('osm_id', r.get('id'))}",
                "name": name,
                "latitude": lat,
                "longitude": lon,
                "kind": kind,
                "population": population(tags.get("population")),
                "prominence": 0.5 if tags.get("wikidata") else 0,
                "wikidata": tags.get("wikidata"),
                "geonames_id": tags.get("geonames:id"),
            }


def natural_earth(path, kind):
    from shapely import make_valid
    from shapely.geometry import mapping, shape

    data = json.loads(Path(path).read_text())
    for index, feature in enumerate(data["features"]):
        props = feature["properties"]
        low = {k.lower(): v for k, v in props.items()}
        name = low.get("name_en") or low.get("name") or low.get("name_long")
        if not name or not feature.get("geometry"):
            continue
        geom = shape(feature["geometry"])
        if not geom.is_valid:
            geom = make_valid(geom)
        if geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        center = geom.representative_point()
        feature_kind = (
            "continent"
            if str(low.get("featurecla", "")).lower() == "continent"
            else kind
        )
        # Marine layer includes named seas; these remain ocean-type coarse anchors.
        yield {
            "source": "natural-earth",
            "source_id": f"{Path(path).stem}:{low.get('ne_id', index)}:{index}",
            "ne_id": low.get("ne_id"),
            "name": name,
            "latitude": center.y,
            "longitude": center.x,
            "kind": feature_kind,
            "population": population(low.get("pop_est")),
            "prominence": max(0, min(1, 1 - float(low.get("scalerank") or 0) / 10)),
            "geometry": mapping(geom),
        }


def place_boundaries(path, source, kind, name_field):
    """Normalize Polygon/MultiPolygon features from a curated GeoJSON source."""
    from shapely import make_valid
    from shapely.geometry import mapping, shape

    for index, feature in enumerate(json.loads(Path(path).read_text())["features"]):
        name = feature["properties"].get(name_field)
        if not name or not feature.get("geometry"):
            continue
        geom = make_valid(shape(feature["geometry"]))
        if geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon"):
            raise ValueError(f"{source}: invalid polygon for {name}")
        center = geom.representative_point()
        yield {
            "source": source,
            "source_id": str(feature.get("id", f"{name}:{index}")),
            "name": name,
            "latitude": center.y,
            "longitude": center.x,
            "kind": kind,
            "prominence": 1.0,
            "geometry": mapping(geom),
        }


def pbf(path):
    """Stream named place nodes from PBF; no planet-wide node-location cache."""
    import osmium

    for node in osmium.FileProcessor(str(path), osmium.osm.NODE):
        tags = node.tags
        kind = tags.get("place")
        name = tags.get("name:en") or tags.get("name")
        if kind not in OSM_TYPES or not name or not node.location.valid():
            continue
        yield {
            "source": "osm",
            "source_id": f"node:{node.id}",
            "name": name,
            "latitude": node.lat,
            "longitude": node.lon,
            "kind": kind,
            "population": population(tags.get("population")),
            "prominence": 0.5 if tags.get("wikidata") else 0,
            "wikidata": tags.get("wikidata"),
            "geonames_id": tags.get("geonames:id"),
        }


def normalize(
    kind,
    path,
    output,
    region_kind="region",
    boundary_source=None,
    boundary_kind="neighbourhood",
    name_field="name",
):
    if kind == "place-boundaries" and not boundary_source:
        raise ValueError("place-boundaries requires --boundary-source")
    readers = {
        "geonames": geonames,
        "osmnames": osmnames,
        "osm-jsonl": osm_jsonl,
        "pbf": pbf,
        "natural-earth": lambda p: natural_earth(p, region_kind),
        "place-boundaries": lambda p: place_boundaries(
            p, boundary_source, boundary_kind, name_field
        ),
    }
    count = 0
    rejected_names = 0
    output = Path(output)
    if output.exists():
        raise FileExistsError(output)
    temporary = output.with_suffix(output.suffix + ".partial")
    with temporary.open("x", encoding="utf8") as f:
        for record in readers[kind](path):
            try:
                record = validate_record(record)
            except ValueError as error:
                if str(error) != "place needs a nonempty name":
                    raise
                rejected_names += 1
                continue
            f.write(
                json.dumps(
                    record, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                )
                + "\n"
            )
            count += 1
    temporary.replace(output)
    output.with_suffix(output.suffix + ".stats.json").write_text(
        json.dumps({"records": count, "rejected_empty_or_symbol_names": rejected_names})
        + "\n"
    )
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "kind",
        choices=[
            "geonames",
            "osmnames",
            "osm-jsonl",
            "pbf",
            "natural-earth",
            "place-boundaries",
        ],
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--region-kind", choices=sorted(COARSE), default="region")
    parser.add_argument("--boundary-source")
    parser.add_argument(
        "--boundary-kind",
        default="neighbourhood",
        choices=["city", "town", "metropolis", "suburb", "quarter", "neighbourhood"],
    )
    parser.add_argument("--name-field", default="name")
    args = parser.parse_args()
    print(
        json.dumps(
            {
                "records": normalize(
                    args.kind,
                    args.input,
                    args.output,
                    args.region_kind,
                    args.boundary_source,
                    args.boundary_kind,
                    args.name_field,
                )
            }
        )
    )


if __name__ == "__main__":
    main()
