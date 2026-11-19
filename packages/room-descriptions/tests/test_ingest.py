import gzip
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from geochalk_geo.ingest import normalize


class IngestionTests(unittest.TestCase):
    def test_geonames_and_osm_sources_preserve_ids_and_types(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            row = [
                "123",
                "San Francisco",
                "San Francisco",
                "SF",
                "37.7749",
                "-122.4194",
                "P",
                "PPLA2",
                "US",
                "",
                "CA",
                "",
                "",
                "",
                "800000",
                "",
                "",
                "America/Los_Angeles",
                "2026-01-01",
            ]
            with zipfile.ZipFile(temp / "cities.zip", "w") as z:
                z.writestr("cities1000.txt", "\t".join(row) + "\n")
            normalize("geonames", temp / "cities.zip", temp / "gn.jsonl")
            place = json.loads((temp / "gn.jsonl").read_text())
            self.assertEqual(
                (place["source_id"], place["kind"], place["population"]),
                ("123", "city", 800000),
            )
            tsv = "name\tosm_type\tosm_id\ttype\tlon\tlat\timportance\nOuter Richmond\tnode\t234\tneighbourhood\t-122.495\t37.7777\t0.2\nRoad\tway\t456\tresidential\t0\t0\t0\n***\tnode\t789\tvillage\t0\t0\t0\n"
            with gzip.open(temp / "osm.tsv.gz", "wt") as f:
                f.write(tsv)
            self.assertEqual(
                normalize("osmnames", temp / "osm.tsv.gz", temp / "osm.jsonl"), 1
            )
            place = json.loads((temp / "osm.jsonl").read_text())
            self.assertEqual(
                (place["source_id"], place["kind"]), ("node:234", "neighbourhood")
            )
            stats = json.loads((temp / "osm.jsonl.stats.json").read_text())
            self.assertEqual(stats["rejected_empty_or_symbol_names"], 1)

    def test_geonames_populous_neighborhood_is_not_a_major_city(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            row = [
                "124",
                "District",
                "District",
                "",
                "40",
                "-74",
                "P",
                "PPLX",
                "US",
                "",
                "NY",
                "",
                "",
                "",
                "300000",
                "",
                "",
                "America/New_York",
                "2026-01-01",
            ]
            with zipfile.ZipFile(temp / "cities.zip", "w") as z:
                z.writestr("cities1000.txt", "\t".join(row) + "\n")
            normalize("geonames", temp / "cities.zip", temp / "out.jsonl")
            self.assertEqual(
                json.loads((temp / "out.jsonl").read_text())["kind"], "neighbourhood"
            )

    def test_osm_centers_and_natural_earth_polygon(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            source = {
                "id": 123,
                "type": "relation",
                "center": {"lat": 2, "lon": 3},
                "tags": {
                    "name": "Local name",
                    "name:en": "English name",
                    "place": "suburb",
                },
            }
            (temp / "source.jsonl").write_text(json.dumps(source) + "\n")
            normalize("osm-jsonl", temp / "source.jsonl", temp / "out.jsonl")
            self.assertEqual(
                json.loads((temp / "out.jsonl").read_text())["name"], "English name"
            )
            geo = {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"name": "Country", "ne_id": 42},
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
                        },
                    }
                ],
            }
            (temp / "region.geojson").write_text(json.dumps(geo))
            normalize(
                "natural-earth",
                temp / "region.geojson",
                temp / "region.jsonl",
                "country",
            )
            place = json.loads((temp / "region.jsonl").read_text())
            self.assertEqual(place["kind"], "country")
            self.assertEqual(place["longitude"], 2)
            self.assertIn("geometry", place)

    def test_failed_import_does_not_publish_partial_output(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            (temp / "bad.jsonl").write_text("{broken")
            with self.assertRaises(ValueError):
                normalize("osm-jsonl", temp / "bad.jsonl", temp / "out.jsonl")
            self.assertFalse((temp / "out.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
