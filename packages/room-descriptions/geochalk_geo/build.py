"""Deterministic offline build; spatial/scientific packages are build-only."""

import argparse
import hashlib
import json
import math
import platform
import sqlite3
import time
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import scipy
import shapely
from scipy.spatial import cKDTree
from shapely.geometry import shape
from shapely.strtree import STRtree
from .fine import write_index

from .geometry import (
    MEAN_EARTH_RADIUS_KM,
    decode_cell,
    distance_km,
    encode,
    geohash_key,
)

COARSE = {"country", "state", "region", "ocean", "continent"}
LOCAL = {"city", "town", "village", "suburb", "quarter", "neighbourhood", "metropolis"}
DEFAULT_TYPES = {
    "continent": 1,
    "country": 0.95,
    "ocean": 0.9,
    "state": 0.8,
    "region": 0.75,
    "metropolis": 0.85,
    "city": 0.7,
    "town": 0.5,
    "village": 0.25,
    "suburb": 0.35,
    "quarter": 0.25,
    "neighbourhood": 0.2,
}
SCHEMA = """
CREATE TABLE places(id INTEGER PRIMARY KEY,name TEXT NOT NULL,latitude REAL NOT NULL,
 longitude REAL NOT NULL,importance REAL NOT NULL);
CREATE TABLE room_anchors(geohash_key INTEGER PRIMARY KEY,place_id INTEGER NOT NULL REFERENCES places(id));
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
"""


@dataclass
class BuildConfig:
    target_places: int = 1_000_000
    candidates: int = 32
    importance_weight: float = 0.25
    population_weight: float = 0.5
    type_weight: float = 0.3
    prominence_weight: float = 0.2
    dedup_km: float = 2.0
    neighbourhood_dedup_km: float = 0.5
    remote_scale: float = 3.0
    remote_min_km: float = 100.0
    type_scores: dict = field(default_factory=lambda: dict(DEFAULT_TYPES))

    def validate(self):
        if (
            not isinstance(self.target_places, int)
            or not isinstance(self.candidates, int)
            or self.target_places < 1
            or self.candidates < 1
        ):
            raise ValueError("target_places and candidates must be positive")
        for name in (
            "importance_weight",
            "population_weight",
            "type_weight",
            "prominence_weight",
            "dedup_km",
            "neighbourhood_dedup_km",
            "remote_scale",
            "remote_min_km",
        ):
            value = getattr(self, name)
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} must be finite and nonnegative")
        if not all(math.isfinite(v) and 0 <= v <= 1 for v in self.type_scores.values()):
            raise ValueError("type_scores must be between zero and one")
        if self.population_weight + self.type_weight + self.prominence_weight == 0:
            raise ValueError("importance weights must have a positive sum")


def normalized_name(name):
    return "".join(
        c for c in unicodedata.normalize("NFKD", name).casefold() if c.isalnum()
    )


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def importance(record, config):
    population = min(1, math.log10(1 + (record.get("population") or 0)) / 7)
    total = config.population_weight + config.type_weight + config.prominence_weight
    return round(
        (
            config.population_weight * population
            + config.type_weight * config.type_scores.get(record["kind"], 0)
            + config.prominence_weight * record.get("prominence", 0)
        )
        / total,
        6,
    )


def validate_record(r):
    r = dict(r)
    r["name"] = " ".join(str(r["name"]).split())
    if not r["name"] or not normalized_name(r["name"]):
        raise ValueError("place needs a nonempty name")
    if r["kind"] not in COARSE | LOCAL:
        raise ValueError(f"unsupported kind: {r['kind']}")
    for key, lo, hi in (
        ("latitude", -90, 90),
        ("longitude", -180, 180),
        ("prominence", 0, 1),
    ):
        r[key] = float(r.get(key, 0))
        if not math.isfinite(r[key]) or not lo <= r[key] <= hi:
            raise ValueError(f"invalid {key}")
    r["longitude"] = (r["longitude"] + 180) % 360 - 180
    if r.get("population") is not None:
        r["population"] = int(r["population"])
        if r["population"] < 0:
            raise ValueError("negative population")
    for key in ("source", "source_id"):
        if not str(r.get(key, "")):
            raise ValueError(f"missing {key}")
        r[key] = str(r[key])
    return r


def stage_inputs(paths, stage, config):
    """Disk-backed raw provenance and spatial dedup; fixed ordering, not input ordering."""
    db = sqlite3.connect(stage)
    db.executescript(
        """
      CREATE TABLE raw(source TEXT,source_id TEXT,priority INTEGER,body TEXT,
                       PRIMARY KEY(source,source_id)) WITHOUT ROWID;
      CREATE TABLE canonical(id INTEGER PRIMARY KEY,name TEXT,norm TEXT,lat REAL,lon REAL,
        kind TEXT,importance REAL,population INTEGER,bucket TEXT,geometry TEXT);
      CREATE VIRTUAL TABLE spatial USING rtree(id,min_lon,max_lon,min_lat,max_lat);
      CREATE INDEX name_kind ON canonical(norm,kind);
      CREATE TABLE provenance(source TEXT,source_id TEXT,place_id INTEGER,
                              PRIMARY KEY(source,source_id)) WITHOUT ROWID;
    """
    )
    sources = []
    for path in sorted(map(Path, paths)):
        sources.append({"file": path.name, "sha256": sha256(path)})
        with path.open(encoding="utf8") as f:
            for line_number, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    r = validate_record(json.loads(line))
                except (ValueError, KeyError, TypeError) as e:
                    raise ValueError(f"{path}:{line_number}: {e}") from e
                body = json.dumps(
                    r, sort_keys=True, ensure_ascii=False, separators=(",", ":")
                )
                priority = 0 if r["source"] == "geonames" else 1
                old = db.execute(
                    "SELECT body FROM raw WHERE source=? AND source_id=?",
                    (r["source"], r["source_id"]),
                ).fetchone()
                if old and old[0] != body:
                    raise ValueError(
                        f"conflicting duplicate source ID {r['source']}:{r['source_id']}"
                    )
                db.execute(
                    "INSERT OR IGNORE INTO raw VALUES(?,?,?,?)",
                    (r["source"], r["source_id"], priority, body),
                )
        db.commit()
    neighborhoods = {"suburb", "quarter", "neighbourhood"}
    for source, source_id, body in db.execute(
        "SELECT source,source_id,body FROM raw ORDER BY priority,source,source_id"
    ):
        r = json.loads(body)
        norm, kind = normalized_name(r["name"]), r["kind"]
        lat, lon = r["latitude"], r["longitude"]
        group = (
            neighborhoods
            if kind in neighborhoods
            else (
                {"city", "town", "village", "metropolis"} if kind in LOCAL else {kind}
            )
        )
        radius = (
            config.neighbourhood_dedup_km if kind in neighborhoods else config.dedup_km
        )
        # Name index keeps duplicates sparse; exact spherical distance handles wrapping/poles.
        matches = [
            row
            for row in db.execute(
                "SELECT id,lat,lon,kind,importance FROM canonical WHERE norm=? ORDER BY id",
                (norm,),
            )
            if row[3] in group and distance_km(lat, lon, row[1], row[2]) <= radius
        ]
        score = importance(r, config)
        if matches:
            chosen = min(
                matches, key=lambda row: (distance_km(lat, lon, row[1], row[2]), row[0])
            )
            place_id = chosen[0]
            db.execute(
                """UPDATE canonical SET importance=max(importance,?),
                population=max(coalesce(population,0),?), geometry=coalesce(geometry,?)
                WHERE id=?""",
                (
                    score,
                    r.get("population") or 0,
                    (
                        json.dumps(r["geometry"], separators=(",", ":"), sort_keys=True)
                        if r.get("geometry")
                        else None
                    ),
                    place_id,
                ),
            )
        else:
            geometry = (
                json.dumps(r["geometry"], separators=(",", ":"), sort_keys=True)
                if r.get("geometry")
                else None
            )
            place_id = db.execute(
                "INSERT INTO canonical(name,norm,lat,lon,kind,importance,population,bucket,geometry) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    r["name"],
                    norm,
                    lat,
                    lon,
                    kind,
                    score,
                    r.get("population"),
                    encode(lat, lon, 3),
                    geometry,
                ),
            ).lastrowid
            db.execute(
                "INSERT INTO spatial VALUES(?,?,?,?,?)", (place_id, lon, lon, lat, lat)
            )
        db.execute(
            "INSERT INTO provenance VALUES(?,?,?)", (source, source_id, place_id)
        )
    db.commit()
    count = db.execute("SELECT count(*) FROM canonical").fetchone()[0]
    # Geographic round-robin avoids discarding low-population countries when capping size.
    marks = ",".join("?" for _ in COARSE)
    region_rows = db.execute(
        f"SELECT * FROM canonical WHERE kind IN ({marks}) ORDER BY id", sorted(COARSE)
    ).fetchall()
    if len(region_rows) > config.target_places:
        raise ValueError("target_places is smaller than the regional supplement")
    rows = db.execute(
        f"""SELECT id,name,norm,lat,lon,kind,importance,population,bucket,geometry FROM (
        SELECT *,row_number() OVER(PARTITION BY bucket ORDER BY importance DESC,id) AS geographic_rank
        FROM canonical WHERE kind NOT IN ({marks}))
        ORDER BY geographic_rank,importance DESC,id LIMIT ?""",
        (*sorted(COARSE), config.target_places - len(region_rows)),
    ).fetchall()
    rows = sorted(region_rows + rows)
    db.close()
    return rows, sources, count


def vectors(latitudes, longitudes):
    lat, lon = np.radians(latitudes), np.radians(longitudes)
    return np.column_stack(
        (np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat))
    )


class Selector:
    def __init__(self, rows, config):
        self.rows, self.config = rows, config
        self.ids = np.array([r[0] for r in rows], dtype=np.int64)
        self.xyz = vectors([r[3] for r in rows], [r[4] for r in rows])
        self.importance = np.array([r[6] for r in rows])
        self.pools = {}
        for level in range(1, 6):
            indices = [
                i
                for i, r in enumerate(rows)
                if (
                    r[5] in COARSE
                    if level <= 2
                    else (
                        r[5] in {"city", "metropolis"}
                        if level == 3
                        else (
                            r[5] in {"city", "town", "metropolis"}
                            or (r[5] == "village" and (r[7] or 0) >= 1000)
                            if level == 4
                            else r[5]
                            in {"town", "village", "suburb", "quarter", "neighbourhood"}
                        )
                    )
                )
            ]
            if not indices:
                indices = [i for i, r in enumerate(rows) if r[5] in LOCAL] or list(
                    range(len(rows))
                )
            array = np.array(indices)
            self.pools[level] = (array, cKDTree(self.xyz[array]))
        region_indices = [i for i, r in enumerate(rows) if r[5] in COARSE]
        self.region_indices = np.array(region_indices or list(range(len(rows))))
        self.region_tree = cKDTree(self.xyz[self.region_indices])
        self.geometries, self.geometry_indices = [], []
        for i in region_indices:
            if rows[i][9]:
                geom = shape(json.loads(rows[i][9]))
                if (
                    geom.is_empty
                    or not geom.is_valid
                    or geom.geom_type not in ("Polygon", "MultiPolygon")
                ):
                    raise ValueError(f"invalid region geometry for {rows[i][1]}")
                self.geometries.append(geom)
                self.geometry_indices.append(i)
        self.geometry_tree = STRtree(self.geometries)

    def nearest(self, xyz, scale, pool):
        indices, tree = pool
        k = min(self.config.candidates, len(indices))
        chord, local = tree.query(xyz, k=k, workers=1)
        if k == 1:
            chord, local = chord[:, None], local[:, None]
        candidates = indices[local]
        distance = 2 * MEAN_EARTH_RADIUS_KM * np.arcsin(np.clip(chord / 2, 0, 1))
        scores = distance / scale[:, None] + self.config.importance_weight * (
            1 - self.importance[candidates]
        )
        # Distance first in the score; stable place ID resolves ties.
        order = np.lexsort((self.ids[candidates], scores), axis=1)
        best = order[:, 0]
        return candidates[np.arange(len(xyz)), best], distance[:, 0]

    def regions(self, lat, lon, xyz, scale, level=4):
        selected, _ = self.nearest(xyz, scale, (self.region_indices, self.region_tree))
        if self.geometries:
            pairs = self.geometry_tree.query(
                shapely.points(lon, lat), predicate="intersects"
            )
            # Prefer the most specific suitable containing extent. This is offline
            # anchor selection only; runtime never infers "in" from a point.
            best = {}
            for point_i, geom_i in pairs.T:
                i = self.geometry_indices[geom_i]
                if level == 1 and self.rows[i][5] == "state":
                    continue
                area = self.geometries[geom_i].area
                # Match extent size to cell scale for coarse rooms; do not label a
                # continental cell using whichever tiny province contains its center.
                approximate_km2 = max(
                    1,
                    area
                    * 111.195**2
                    * max(0.01, math.cos(math.radians(float(lat[point_i])))),
                )
                extent_fit = abs(
                    math.log(approximate_km2 / max(1, float(scale[point_i]) ** 2))
                )
                key = (
                    extent_fit if level <= 2 else area,
                    -self.importance[i],
                    self.ids[i],
                )
                if point_i not in best or key < best[point_i][0]:
                    best[point_i] = (key, i)
            for point_i, (_, i) in best.items():
                selected[point_i] = i
        return selected

    def select(self, level, lat, lon, scale):
        xyz = vectors(lat, lon)
        if level <= 2:
            chosen = self.regions(lat, lon, xyz, scale, level)
        else:
            chosen, distance = self.nearest(xyz, scale, self.pools[level])
            remote = distance > np.maximum(
                self.config.remote_min_km, self.config.remote_scale * scale
            )
            if remote.any():
                chosen[remote] = self.regions(
                    lat[remote], lon[remote], xyz[remote], scale[remote]
                )
        return self.ids[chosen]


def cells(level, start, stop):
    """Vectorized geohash decoding in bounded batches (no 33M room allocation)."""
    values = np.arange(start, stop, dtype=np.int64)
    west, east = np.full(len(values), -180.0), np.full(len(values), 180.0)
    south, north = np.full(len(values), -90.0), np.full(len(values), 90.0)
    for bit in range(5 * level):
        high = ((values >> (5 * level - bit - 1)) & 1).astype(bool)
        if bit % 2 == 0:
            mid = (west + east) / 2
            west, east = np.where(high, mid, west), np.where(high, east, mid)
        else:
            mid = (south + north) / 2
            south, north = np.where(high, mid, south), np.where(high, north, mid)
    scale = np.sqrt(
        MEAN_EARTH_RADIUS_KM**2
        * (np.sin(np.radians(north)) - np.sin(np.radians(south)))
        * np.radians(east - west)
    )
    return values + (1 << (5 * level)), (south + north) / 2, (west + east) / 2, scale


def build(
    paths,
    output,
    *,
    config=None,
    build_date="1970-01-01T00:00:00Z",
    exact_prefixes=(),
    source_manifest=None,
):
    config = config or BuildConfig()
    config.validate()
    output = Path(output)
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = output.with_suffix(".build.sqlite")
    temporary = output.with_suffix(".partial.sqlite")
    if stage.exists() or temporary.exists():
        raise FileExistsError(
            "build work files already exist; choose a new output path"
        )
    started = time.perf_counter()
    rows, sources, canonical_count = stage_inputs(paths, stage, config)
    if not rows:
        raise ValueError("gazetteer is empty")
    with sqlite3.connect(stage) as provenance_db:
        provenance_db.execute("CREATE TABLE published_places(id INTEGER PRIMARY KEY)")
        provenance_db.executemany(
            "INSERT INTO published_places VALUES(?)", ((r[0],) for r in rows)
        )
    provenance_db.close()
    selector = Selector(rows, config)
    db = sqlite3.connect(temporary)
    db.executescript(
        "PRAGMA page_size=4096; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;"
        + SCHEMA
    )
    db.executemany(
        "INSERT INTO places VALUES(?,?,?,?,?)",
        ((r[0], r[1], r[3], r[4], r[6]) for r in rows),
    )
    write_index(db, rows)
    for level in range(1, 5):
        for start in range(0, 32**level, 8192):
            keys, lat, lon, scale = cells(level, start, min(start + 8192, 32**level))
            ids = selector.select(level, lat, lon, scale)
            db.executemany(
                "INSERT INTO room_anchors VALUES(?,?)",
                ((int(k), int(p)) for k, p in zip(keys, ids)),
            )
        db.commit()
        print(f"indexed precision {level}: {32**level:,} rooms", flush=True)
    for prefix in sorted(set(exact_prefixes)):
        cell = decode_cell(prefix)
        if len(prefix) != 5:
            raise ValueError("exact optional anchors must have precision 5")
        lat, lon = cell.center
        anchor = selector.select(
            5, np.array([lat]), np.array([lon]), np.array([math.sqrt(cell.area_km2)])
        )[0]
        db.execute(
            "INSERT INTO room_anchors VALUES(?,?)", (geohash_key(prefix), int(anchor))
        )
    metadata = {
        "schema_version": "1",
        "build_date": build_date,
        "sources": json.dumps(sources, sort_keys=True),
        "config": json.dumps(asdict(config), sort_keys=True),
        "place_count": str(len(rows)),
        "canonical_input_count": str(canonical_count),
        "precomputed_levels": "1,2,3,4",
        "fine_lookup": "7",
        "area_model": "sphere R=6371008.8 meters",
        "build_environment": json.dumps(
            {
                "python": platform.python_version(),
                "sqlite": sqlite3.sqlite_version,
                "numpy": np.__version__,
                "scipy": scipy.__version__,
                "shapely": shapely.__version__,
            },
            sort_keys=True,
        ),
        "attribution": "GeoNames CC BY 4.0; OpenStreetMap contributors ODbL; Natural Earth public domain",
    }
    if source_manifest:
        metadata["source_versions"] = json.dumps(
            json.loads(Path(source_manifest).read_text()), sort_keys=True
        )
    db.executemany("INSERT INTO metadata VALUES(?,?)", sorted(metadata.items()))
    db.commit()
    db.executescript("ANALYZE; VACUUM;")
    if (
        db.execute("PRAGMA integrity_check").fetchone() != ("ok",)
        or db.execute("PRAGMA foreign_key_check").fetchall()
    ):
        raise RuntimeError("database verification failed")
    for level in range(1, 5):
        count = db.execute(
            "SELECT count(*) FROM room_anchors WHERE geohash_key BETWEEN ? AND ?",
            (32**level, 2 * 32**level - 1),
        ).fetchone()[0]
        assert count == 32**level
    db.close()
    temporary.replace(output)
    output.chmod(0o444)
    report = {
        "database": output.name,
        "places": len(rows),
        "canonical_input_places": canonical_count,
        "anchors": 1_082_400 + len(set(exact_prefixes)),
        "bytes": output.stat().st_size,
        "build_seconds": time.perf_counter() - started,
        "sha256": sha256(output),
        "build_date": build_date,
    }
    output.with_suffix(".manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--build-date",
        required=True,
        help="fixed ISO date; part of reproducible configuration",
    )
    parser.add_argument("--config", type=Path)
    parser.add_argument("--source-manifest", type=Path)
    parser.add_argument("--exact-prefix", action="append", default=[])
    args = parser.parse_args()
    cfg = (
        BuildConfig(**json.loads(args.config.read_text()))
        if args.config
        else BuildConfig()
    )
    build(
        args.inputs,
        args.output,
        config=cfg,
        build_date=args.build_date,
        exact_prefixes=args.exact_prefix,
        source_manifest=args.source_manifest,
    )


if __name__ == "__main__":
    main()
