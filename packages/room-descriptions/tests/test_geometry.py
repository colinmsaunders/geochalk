import unittest

from geochalk_geo.geometry import (
    ALPHABET,
    Cell,
    compass_direction,
    decode_cell,
    distance_km,
)


class GeometryTests(unittest.TestCase):
    def test_known_bounds(self):
        self.assertEqual(decode_cell("s"), Cell(0, 45, 0, 45))
        self.assertEqual(
            decode_cell("9q8yy"),
            Cell(37.7490234375, 37.79296875, -122.431640625, -122.3876953125),
        )

    def test_area_partitions_sphere(self):
        total = sum(decode_cell(c).area_km2 for c in ALPHABET)
        self.assertAlmostEqual(total, 510065880.9728718, delta=0.01)
        for prefix in ("9", "9q", "9q8", "9q8y", "z", "zz", "zzzz"):
            self.assertAlmostEqual(
                sum(decode_cell(prefix + c).area_km2 for c in ALPHABET),
                decode_cell(prefix).area_km2,
                delta=0.000001,
            )

    def test_area_latitude_and_units(self):
        self.assertLess(decode_cell("zzzzz").area_km2, decode_cell("s0000").area_km2)
        self.assertAlmostEqual(
            decode_cell("9q8yy").area("meters")
            / 1_000_000
            / decode_cell("9q8yy").area("miles"),
            2.589988110336,
        )
        with self.assertRaises(ValueError):
            decode_cell("s").area("km")

    def test_invalid_prefixes(self):
        for value in ("", "_", "9q8yyk123", "A", "a", "i", "o", "S", None, 3):
            with self.subTest(value=value), self.assertRaises(ValueError):
                decode_cell(value)

    def test_direction_and_dateline(self):
        self.assertEqual(compass_direction(0, 0, 1, 1), "northeast")
        self.assertEqual(compass_direction(0, 179.9, 0, -179.9), "east")
        self.assertLess(distance_km(0, 179.9, 0, -179.9), 23)
        self.assertAlmostEqual(distance_km(0, 0, 0, 180), 20015.114442, places=5)


if __name__ == "__main__":
    unittest.main()
