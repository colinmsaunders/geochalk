"""Pure formatting: no database, cache, network or build-time dependencies."""

import math
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from .geometry import Cell, compass_direction, distance_km
from .models import Place


def rounded_area(value: float) -> str:
    if not math.isfinite(value) or value <= 0:
        raise ValueError("area must be finite and positive")
    quantum = Decimal(1).scaleb(math.floor(math.log10(value)) - 1)
    number = Decimal(str(value)).quantize(quantum, rounding=ROUND_HALF_UP)
    result = format(number, "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def relationship(cell: Cell, place: Place) -> str:
    lat, lon = cell.center
    distance = distance_km(place.latitude, place.longitude, lat, lon)
    scale = math.sqrt(cell.area_km2)
    if cell.contains(place.latitude, place.longitude) or distance <= scale * 0.1:
        return "around"
    # Near the poles or antipode the compass bearing is unstable/ambiguous.
    if (
        distance <= scale * 0.35
        or abs(lat) > 89.9
        or abs(place.latitude) > 89.9
        or distance > math.pi * 6371.0088 - 1
    ):
        return "near"
    return compass_direction(place.latitude, place.longitude, lat, lon) + " of"


def format_description(
    cell: Cell, place: Place, unit: Literal["miles", "meters"] = "miles"
) -> str:
    if unit == "miles":
        area, label = cell.area("miles"), "square miles"
    elif unit == "meters":
        area, label = cell.area_m2, "square meters"
        if area >= 1_000_000:
            area, label = area / 1_000_000, "square kilometers"
    else:
        raise ValueError("unit must be 'miles' or 'meters'")
    return f"{rounded_area(area)} {label} {relationship(cell, place)} {place.name}"
