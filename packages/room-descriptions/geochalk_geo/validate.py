"""Read-only coverage audit, global samples, and lookup latency benchmark."""

import argparse
import json
import random
import sqlite3
import statistics
import time
from pathlib import Path

from .geometry import encode, from_value
from .runtime import Gazetteer

SAMPLES = {
    "San Francisco": (37.7749, -122.4194),
    "Outer Richmond": (37.7777, -122.495),
    "New York": (40.7128, -74.006),
    "London": (51.5074, -0.1278),
    "Tokyo": (35.6762, 139.6503),
    "Rural California": (37.3614, -118.3997),
    "Sahara": (24, 15),
    "Pacific": (0, -150),
    "Dateline east": (0, 179.99),
    "Dateline west": (0, -179.99),
    "High north": (89, 30),
    "High south": (-89, -30),
}


def validate(path, samples=1000):
    path = Path(path).resolve()
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    assert not db.execute("PRAGMA foreign_key_check").fetchall()
    counts = {}
    for level in range(1, 5):
        counts[level] = db.execute(
            "SELECT count(*) FROM room_anchors WHERE geohash_key BETWEEN ? AND ?",
            (32**level, 2 * 32**level - 1),
        ).fetchone()[0]
        assert counts[level] == 32**level, (level, counts[level])
    # Unique integer keys plus a full count in each exact key interval proves complete coverage.
    # Every 5-character string has a 4-character parent in that interval: covers all 33M fallbacks.
    assert (
        db.execute(
            "SELECT count(*) FROM room_anchors a LEFT JOIN places p ON p.id=a.place_id WHERE p.id IS NULL"
        ).fetchone()[0]
        == 0
    )
    plan = db.execute(
        "EXPLAIN QUERY PLAN SELECT p.name FROM room_anchors a JOIN places p ON p.id=a.place_id WHERE a.geohash_key=?",
        (32,),
    ).fetchall()
    assert sum("INTEGER PRIMARY KEY" in row[3] for row in plan) == 2, plan
    try:
        db.execute("DELETE FROM room_anchors")
    except sqlite3.OperationalError:
        pass
    else:
        raise AssertionError("database was writable")
    db.close()
    rng = random.Random(20261116)
    prefixes = [from_value(rng.randrange(32**5), 5) for _ in range(samples)]
    with Gazetteer(path, cache_size=0) as uncached, Gazetteer(path) as cached:
        cold = []
        for prefix in prefixes:
            start = time.perf_counter_ns()
            expected = uncached.get_geoname(prefix)
            cold.append(time.perf_counter_ns() - start)
            assert cached.get_geoname(prefix) == expected
        warm = []
        for prefix in prefixes:
            start = time.perf_counter_ns()
            cached.get_geoname(prefix)
            warm.append(time.perf_counter_ns() - start)
        descriptions = {
            name: {
                str(p): cached.get_room_description(encode(lat, lon, p))
                for p in (1, 2, 3, 4, 5)
            }
            for name, (lat, lon) in SAMPLES.items()
        }
    opens = []
    for prefix in prefixes[: min(100, len(prefixes))]:
        start = time.perf_counter_ns()
        with Gazetteer(path, cache_size=0) as fresh:
            fresh.get_geoname(prefix)
        opens.append(time.perf_counter_ns() - start)

    def stats(values):
        return {
            "median_us": statistics.median(values) / 1000,
            "p95_us": sorted(values)[int(0.95 * (len(values) - 1))] / 1000,
        }

    result = {
        "bytes": path.stat().st_size,
        "counts": counts,
        "samples": samples,
        "uncached_lookup": stats(cold),
        "cached_lookup": stats(warm),
        "fresh_connection_lookup": stats(opens),
        "latency_note": "OS page cache not flushed; fresh connection is not cold disk I/O",
        "query_plan": plan,
        "descriptions": descriptions,
    }
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("database", type=Path)
    p.add_argument("--samples", type=int, default=1000)
    p.add_argument("--output", type=Path)
    args = p.parse_args()
    if args.samples < 1:
        p.error("samples must be positive")
    text = (
        json.dumps(validate(args.database, args.samples), indent=2, ensure_ascii=False)
        + "\n"
    )
    if args.output:
        args.output.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
