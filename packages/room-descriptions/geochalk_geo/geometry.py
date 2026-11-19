"""Geohash cell geometry, with no third-party or network dependencies.

Areas integrate the specified mean-radius sphere between cell meridians and
parallels, rather than multiplying fixed cell dimensions.
Distances and compass bearings use the mean-radius spherical approximation.
"""

import math
from dataclasses import dataclass

ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz"
MEAN_EARTH_RADIUS_KM = 6371.0088
SQ_KM_PER_SQ_MILE = 1.609344**2


@dataclass(frozen=True)
class Cell:
    south: float
    north: float
    west: float
    east: float

    @property
    def center(self) -> tuple[float, float]:
        return (self.south + self.north) / 2, (self.west + self.east) / 2

    @property
    def area_m2(self) -> float:
        return (
            6_371_008.8**2
            * abs(
                math.sin(math.radians(self.north)) - math.sin(math.radians(self.south))
            )
            * math.radians(self.east - self.west)
        )

    @property
    def area_km2(self) -> float:
        return self.area_m2 / 1_000_000

    def area(self, unit: str = "miles") -> float:
        if unit == "miles":
            return self.area_m2 / 2_589_988.110336
        if unit == "meters":
            return self.area_m2
        raise ValueError("unit must be 'miles' or 'meters'")

    def contains(self, latitude: float, longitude: float) -> bool:
        longitude = (longitude + 180) % 360 - 180
        return (
            self.south <= latitude <= self.north and self.west <= longitude < self.east
        )


def decode_cell(prefix: str) -> Cell:
    """Decode a canonical lowercase geohash of length 1–5."""
    if not isinstance(prefix, str) or not 1 <= len(prefix) <= 5:
        raise ValueError("geohash_prefix must contain 1–5 geohash characters")
    south, north, west, east = -90.0, 90.0, -180.0, 180.0
    longitude_bit = True
    for character in prefix:
        if character not in ALPHABET:
            raise ValueError("geohash_prefix must use lowercase geohash Base32")
        value = ALPHABET.index(character)
        for mask in (16, 8, 4, 2, 1):
            if longitude_bit:
                midpoint = (west + east) / 2
                if value & mask:
                    west = midpoint
                else:
                    east = midpoint
            else:
                midpoint = (south + north) / 2
                if value & mask:
                    south = midpoint
                else:
                    north = midpoint
            longitude_bit = not longitude_bit
    return Cell(south, north, west, east)


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance; naturally wraps across the antimeridian."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * MEAN_EARTH_RADIUS_KM * math.asin(math.sqrt(min(1.0, max(0.0, a))))


def compass_direction(lat1: float, lon1: float, lat2: float, lon2: float) -> str:
    """Eight-way direction FROM the named place TO the room center."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    bearing = (
        math.degrees(
            math.atan2(
                math.sin(dl) * math.cos(p2),
                math.cos(p1) * math.sin(p2)
                - math.sin(p1) * math.cos(p2) * math.cos(dl),
            )
        )
        % 360
    )
    return (
        "north",
        "northeast",
        "east",
        "southeast",
        "south",
        "southwest",
        "west",
        "northwest",
    )[int((bearing + 22.5) // 45) % 8]


def geohash_key(prefix: str) -> int:
    decode_cell(prefix)
    key = 1  # Sentinel bit encodes precision; leading zero characters survive.
    for c in prefix:
        key = (key << 5) | ALPHABET.index(c)
    return key


def from_value(value: int, precision: int) -> str:
    if not 1 <= precision <= 5 or not 0 <= value < 32**precision:
        raise ValueError("invalid geohash value or precision")
    return "".join(
        ALPHABET[(value >> (5 * i)) & 31] for i in reversed(range(precision))
    )


def encode(latitude: float, longitude: float, precision: int = 5) -> str:
    if not (
        math.isfinite(latitude)
        and math.isfinite(longitude)
        and -90 <= latitude <= 90
        and -180 <= longitude <= 180
        and 1 <= precision <= 5
    ):
        raise ValueError("invalid coordinates or precision")
    longitude = (longitude + 180) % 360 - 180
    lo = [-180.0, -90.0]
    hi = [180.0, 90.0]
    value = 0
    for bit in range(5 * precision):
        axis = bit % 2
        mid = (lo[axis] + hi[axis]) / 2
        high = (longitude if axis == 0 else latitude) >= mid
        value = (value << 1) | high
        if high:
            lo[axis] = mid
        else:
            hi[axis] = mid
    return from_value(value, precision)
