import json
import socket
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import numpy as np
from geochalk_geo.build import BuildConfig, Selector, build, cells, stage_inputs
from geochalk_geo.formatting import format_description, relationship, rounded_area
from geochalk_geo.geometry import (
    Cell,
    decode_cell,
    encode,
    from_value,
    geohash_key,
)
from geochalk_geo.models import Place
from geochalk_geo.runtime import Gazetteer, configure, get_geoname, get_room_description
from geochalk_geo.validate import validate

FIXTURE = Path(__file__).parents[1] / "fixtures/synthetic.jsonl"


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.path = Path(cls.temp.name) / "test.sqlite"
        cls.report = build([FIXTURE], cls.path, build_date="2026-11-16T00:00:00Z")

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_complete_coverage_read_only_and_indexed(self):
        report = validate(self.path, samples=64)
        self.assertEqual(sum(report["counts"].values()), 1_082_400)
        self.assertEqual(self.report["anchors"], 1_082_400)
        with closing(sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)) as db:
            tables = {
                r[0]
                for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            self.assertEqual(
                {t for t in tables if not t.startswith("sqlite_")},
                {
                    "places",
                    "room_anchors",
                    "metadata",
                    "fine_features",
                    "fine_index",
                    "fine_index_node",
                    "fine_index_parent",
                    "fine_index_rowid",
                },
            )
            self.assertEqual(
                db.execute(
                    "SELECT count(*) FROM room_anchors WHERE geohash_key>=?", (32**5,)
                ).fetchone()[0],
                0,
            )

    def test_fallback_cache_no_network_and_thread_reuse(self):
        with patch.object(
            socket, "socket", side_effect=AssertionError("network forbidden")
        ):
            with (
                Gazetteer(self.path, cache_size=2) as g,
                Gazetteer(self.path, cache_size=0) as uncached,
            ):
                for prefix in ("9q8yy", "u10hb", "xn76u", "zzzzz", "00000"):
                    self.assertEqual(g.get_geoname(prefix), g.get_geoname(prefix[:-1]))
                    self.assertEqual(
                        g.get_room_description(prefix),
                        uncached.get_room_description(prefix),
                    )
                g.get_geoname("9q8yy")
                g.get_geoname("9q8yy")
                self.assertGreater(g.cache_info().hits, 0)
                self.assertLessEqual(g.cache_info().currsize, 2)
                from concurrent.futures import ThreadPoolExecutor

                with ThreadPoolExecutor(4) as pool:
                    result = list(pool.map(g.get_room_description, ["9q8yy"] * 32))
                self.assertEqual(len(set(result)), 1)
            with self.assertRaises(RuntimeError):
                g.get_geoname("s")
        configure(self.path)
        self.assertEqual(get_geoname("9q8yy").name, "San Francisco")
        self.assertIn("square kilometers", get_room_description("9q8yy", "meters"))

    def test_exact_level5_and_recursive_missing_parent(self):
        path = Path(self.temp.name) / "partial.sqlite"
        source = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)
        target = sqlite3.connect(path)
        source.backup(target)
        source.close()
        target.execute(
            "INSERT INTO room_anchors VALUES(?,?)", (geohash_key("9q8yy"), 1)
        )
        target.execute(
            "DELETE FROM room_anchors WHERE geohash_key=?", (geohash_key("u10h"),)
        )
        target.commit()
        target.close()
        with Gazetteer(path) as g:
            self.assertEqual(g.get_geoname("9q8yy").id, 1)
            self.assertEqual(g.get_geoname("u10hb"), g.get_geoname("u10"))

    def test_deterministic_input_order_and_database_bytes(self):
        shuffled = Path(self.temp.name) / "shuffled.jsonl"
        shuffled.write_text(
            "\n".join(reversed(FIXTURE.read_text().splitlines())) + "\n"
        )
        # Data and anchor tables are order-independent; metadata records input hashes.
        other = Path(self.temp.name) / "repeat.sqlite"
        report = build([FIXTURE], other, build_date="2026-11-16T00:00:00Z")
        self.assertEqual(report["sha256"], self.report["sha256"])
        rows, _, _ = stage_inputs(
            [shuffled], Path(self.temp.name) / "shuffle.build.sqlite", BuildConfig()
        )
        rows2, _, _ = stage_inputs(
            [FIXTURE], Path(self.temp.name) / "normal.build.sqlite", BuildConfig()
        )
        self.assertEqual(rows, rows2)

    def test_offline_exact_level5_generation(self):
        prefix = encode(37.7777, -122.495, 5)
        path = Path(self.temp.name) / "exact.sqlite"
        report = build(
            [FIXTURE], path, build_date="2026-11-16T00:00:00Z", exact_prefixes=[prefix]
        )
        self.assertEqual(report["anchors"], 1_082_401)
        with Gazetteer(path) as g:
            self.assertEqual(g.get_geoname(prefix).name, "Outer Richmond")

    def test_invalid_input(self):
        with Gazetteer(self.path) as g:
            for prefix in ("", "_", "9q8yyk123", "9Q8Y", "9q!", None):
                with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                    g.get_geoname(prefix)
            with self.assertRaises(ValueError):
                g.get_room_description("9q8yy", "kilometers")
        with self.assertRaises(FileNotFoundError):
            Gazetteer(Path(self.temp.name) / "missing.sqlite")
        self.assertFalse((Path(self.temp.name) / "missing.sqlite").exists())


class SelectionTests(unittest.TestCase):
    def selector(self, points):
        rows = [
            (i + 1, name, name, lat, lon, kind, imp, pop, "s00", geom)
            for i, (name, lat, lon, kind, imp, pop, geom) in enumerate(points)
        ]
        return Selector(rows, BuildConfig())

    def test_nearby_beats_distant_famous_and_wraps(self):
        s = self.selector(
            [
                ("Local", 0, 179.95, "town", 0.2, 2000, None),
                ("Famous", 0, -160, "city", 1, 10000000, None),
            ]
        )
        self.assertEqual(
            s.select(
                4, np.array([0.0]), np.array([-179.95]), np.array([20.0])
            ).tolist(),
            [1],
        )
        s = self.selector(
            [
                ("Near pole", 89.99, 179, "town", 0.2, 2000, None),
                ("Far south", 80, 0, "city", 1, 10000000, None),
            ]
        )
        self.assertEqual(
            s.select(4, np.array([89.99]), np.array([0.0]), np.array([1.0])).tolist(),
            [1],
        )

    def test_extents_override_remote_representative_points(self):
        geometry = json.dumps(
            {
                "type": "Polygon",
                "coordinates": [
                    [[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]
                ],
            }
        )
        s = self.selector(
            [
                ("Region", 0, 8, "region", 0.5, None, geometry),
                ("Other", 0, 1, "country", 1, None, None),
            ]
        )
        self.assertEqual(
            s.select(2, np.array([0.0]), np.array([0.0]), np.array([100.0])).tolist(),
            [1],
        )

    def test_vectorized_geometry_matches_scalar(self):
        for p in range(1, 6):
            keys, lat, lon, scale = cells(p, 0, min(100, 32**p))
            for i in range(len(keys)):
                prefix = from_value(i, p)
                cell = decode_cell(prefix)
                self.assertEqual(int(keys[i]), geohash_key(prefix))
                self.assertEqual((lat[i], lon[i]), cell.center)
                self.assertAlmostEqual(scale[i] ** 2, cell.area_km2, places=6)
        self.assertNotEqual(geohash_key("0"), geohash_key("00"))

    def test_dedup_is_geographic_and_type_aware(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "input.jsonl"
            base = {
                "source": "geonames",
                "source_id": "1",
                "name": "San José",
                "latitude": 0,
                "longitude": 179.999,
                "kind": "town",
            }
            rows = [
                base,
                {
                    **base,
                    "source": "osm",
                    "source_id": "2",
                    "name": "San Jose",
                    "longitude": -179.999,
                },
                {**base, "source_id": "3", "latitude": 10},
                {**base, "source_id": "4", "kind": "neighbourhood"},
            ]
            path.write_text("".join(json.dumps(r) + "\n" for r in rows))
            _result, _, count = stage_inputs(
                [path], Path(temp) / "work.sqlite", BuildConfig()
            )
            self.assertEqual(count, 3)
            db = sqlite3.connect(Path(temp) / "work.sqlite")
            self.assertEqual(
                db.execute("SELECT count(*) FROM provenance").fetchone()[0], 4
            )
            db.close()


class FormattingTests(unittest.TestCase):
    def test_rounding_units_and_relationship(self):
        self.assertEqual(rounded_area(1234), "1200")
        self.assertEqual(rounded_area(0.00001234), "0.000012")
        self.assertEqual(rounded_area(1.25), "1.3")
        cell = decode_cell("9q8yy")
        place = Place(1, "San Francisco", 37.7749, -122.4194)
        self.assertEqual(relationship(cell, place), "around")
        self.assertTrue(format_description(cell, place).startswith("7.3 square miles"))
        self.assertTrue(
            format_description(cell, place, "meters").startswith("19 square kilometers")
        )
        self.assertIn(
            "square meters", format_description(decode_cell("zzzzz"), place, "meters")
        )
        self.assertEqual(
            relationship(Cell(-0.001, 0.001, -0.001, 0.001), Place(1, "West", 0, -1)),
            "east of",
        )
        self.assertEqual(
            relationship(Cell(89.99, 90, 0, 1), Place(1, "Pole", 89.9, 2)), "near"
        )


if __name__ == "__main__":
    unittest.main()
