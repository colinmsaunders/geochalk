"""Local lookup shared by the build and the read-only Python runtime."""

import json
import math

from .geometry import MEAN_EARTH_RADIUS_KM, distance_km
from .models import Place

NEIGHBORHOODS = {"neighbourhood", "quarter", "suburb"}
# A municipal polygon can deduplicate into an existing settlement classified
# as a village by population. Its geometry still describes a municipality.
CITY_KINDS = {"city", "town", "metropolis", "village"}
RADIUS_KM = 1
SCHEMA = """
CREATE TABLE fine_features(id INTEGER PRIMARY KEY,
 place_id INTEGER NOT NULL REFERENCES places(id), kind TEXT NOT NULL,
 area REAL, polygon TEXT);
CREATE VIRTUAL TABLE fine_index USING rtree(id,min_lon,max_lon,min_lat,max_lat);
"""
QUERY = """
SELECT p.id,p.name,p.latitude,p.longitude,p.importance,f.kind,f.area,f.polygon
FROM fine_index i CROSS JOIN fine_features f ON f.id=i.id
JOIN places p ON p.id=f.place_id
WHERE i.min_lon<=? AND i.max_lon>=? AND i.min_lat<=? AND i.max_lat>=?
"""


def write_index(db, rows):
    from shapely.geometry import mapping, shape

    db.executescript(SCHEMA)

    def insert(place_id, kind, bounds, area=None, polygon=None):
        feature = db.execute(
            "INSERT INTO fine_features(place_id,kind,area,polygon) VALUES(?,?,?,?)",
            (place_id, kind, area, polygon),
        ).lastrowid
        west, south, east, north = bounds
        db.execute(
            "INSERT INTO fine_index VALUES(?,?,?,?,?)",
            (feature, west, east, south, north),
        )

    for place_id, name, _, lat, lon, kind, _, _, _, geometry in rows:
        if kind in NEIGHBORHOODS:
            insert(place_id, kind, (lon, lat, lon, lat))
        if not geometry or kind not in NEIGHBORHOODS | CITY_KINDS:
            continue
        geom = shape(json.loads(geometry))
        if (
            geom.is_empty
            or not geom.is_valid
            or geom.geom_type
            not in (
                "Polygon",
                "MultiPolygon",
            )
        ):
            raise ValueError(f"invalid local boundary for {name}")
        # Index components separately so island groups do not cover huge search boxes.
        for polygon in geom.geoms if geom.geom_type == "MultiPolygon" else (geom,):
            insert(
                place_id,
                kind,
                polygon.bounds,
                geom.area,
                json.dumps(mapping(polygon)["coordinates"], separators=(",", ":")),
            )


def contains(rings, x, y):
    inside = False
    for ring in rings:
        for (ax, ay, *_), (bx, by, *_) in zip(ring, ring[1:]):
            if (ay > y) != (by > y) and x < ax + (bx - ax) * (y - ay) / (by - ay):
                inside = not inside
    return inside


def lookup(db, lat, lon, *, city_only=False):
    angle = 0 if city_only else RADIUS_KM / MEAN_EARTH_RADIUS_KM
    dy = math.degrees(angle)
    dx = math.degrees(math.asin(min(1, math.sin(angle) / math.cos(math.radians(lat)))))
    west, east = lon - dx, lon + dx
    if abs(lat) + dy >= 90:
        spans = [(-180, 180)]
    elif west < -180:
        spans = [(-180, east), (west + 360, 180)]
    elif east > 180:
        spans = [(west, 180), (-180, east - 360)]
    else:
        spans = [(west, east)]
    neighborhoods, cities, points = [], [], []
    for west, east in spans:
        for pid, name, y, x, importance, kind, area, polygon in db.execute(
            QUERY, (east, west, lat + dy, lat - dy)
        ):
            if city_only and (not polygon or kind in NEIGHBORHOODS):
                continue
            place = Place(pid, name, y, x, kind=kind, importance=importance)
            if polygon:
                rings = json.loads(polygon)
                if kind not in NEIGHBORHOODS:
                    cities.append((area, place, rings))
                elif contains(rings, lon, lat):
                    neighborhoods.append((area, place))
            else:
                distance = distance_km(lat, lon, y, x)
                if distance <= RADIUS_KM:
                    points.append((distance, place))

    def rank(match):
        value, place = match[:2]
        return (value, -place.importance, place.id)

    if neighborhoods:
        return min(neighborhoods, key=rank)[1], "in"
    city = min(
        (item for item in cities if contains(item[2], lon, lat)),
        key=rank,
        default=None,
    )
    if city:
        rings = [item[2] for item in cities if item[1].id == city[1].id]
        points = [
            point
            for point in points
            if any(
                contains(ring, point[1].longitude, point[1].latitude) for ring in rings
            )
        ]
    if points:
        return min(points, key=rank)[1], "near"
    return (city[1], "in") if city else None
