import { bounds } from "@geochalk/shared";
import type { DatabaseSync } from "node:sqlite";
import type { Geoname } from "./geoname";

type Ring = [number, number][];
type Feature = Geoname & {
  id: number;
  kind: string;
  area: number | null;
  polygon: string | null;
};
const neighborhoodKinds = new Set(["neighbourhood", "quarter", "suburb"]);
const radiusKm = 1;
const earthRadiusKm = 6371.0088;
const radians = Math.PI / 180;

function contains(rings: Ring[], longitude: number, latitude: number) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1];
      const [bx, by] = ring[i];
      if (
        ay > latitude !== by > latitude &&
        longitude < ax + ((bx - ax) * (latitude - ay)) / (by - ay)
      )
        inside = !inside;
    }
  }
  return inside;
}

function distanceKm(lat: number, lon: number, place: Geoname) {
  const a =
    Math.sin(((lat - place.latitude) * radians) / 2) ** 2 +
    Math.cos(lat * radians) *
      Math.cos(place.latitude * radians) *
      Math.sin(((lon - place.longitude) * radians) / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

export function createFineLookup(db: DatabaseSync) {
  const hasIndex = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE name='fine_index'")
    .get();
  if (!hasIndex) return undefined;
  const search = db.prepare(`
    SELECT p.id,p.name,p.latitude,p.longitude,p.importance,f.kind,f.area,f.polygon
    FROM fine_index i CROSS JOIN fine_features f ON f.id=i.id
    JOIN places p ON p.id=f.place_id
    WHERE i.min_lon<=? AND i.max_lon>=? AND i.min_lat<=? AND i.max_lat>=?
  `);
  return (prefix: string): Geoname | undefined => {
    const { south, north, west, east } = bounds(prefix);
    const lat = (south + north) / 2;
    const lon = (west + east) / 2;
    const angle = radiusKm / earthRadiusKm;
    const dy = angle / radians;
    const dx =
      Math.asin(Math.min(1, Math.sin(angle) / Math.cos(lat * radians))) /
      radians;
    const left = lon - dx;
    const right = lon + dx;
    let spans = [[left, right]];
    if (Math.abs(lat) + dy >= 90) spans = [[-180, 180]];
    else if (left < -180)
      spans = [
        [-180, right],
        [left + 360, 180],
      ];
    else if (right > 180)
      spans = [
        [left, 180],
        [-180, right - 360],
      ];
    const neighborhoods: Match[] = [];
    const cities: (Match & { rings: Ring[] })[] = [];
    const points: Match[] = [];
    for (const [min, max] of spans) {
      for (const feature of search.all(
        max,
        min,
        lat + dy,
        lat - dy,
      ) as unknown as Feature[]) {
        if (feature.polygon && feature.area !== null) {
          const rings = JSON.parse(feature.polygon) as Ring[];
          const match = { feature, value: feature.area, rings };
          if (!neighborhoodKinds.has(feature.kind)) cities.push(match);
          else if (contains(rings, lon, lat)) neighborhoods.push(match);
        } else {
          const distance = distanceKm(lat, lon, feature);
          if (distance <= radiusKm) points.push({ feature, value: distance });
        }
      }
    }
    const neighborhood = neighborhoods.sort(rank)[0];
    const city = cities
      .filter(({ rings }) => contains(rings, lon, lat))
      .sort(rank)[0];
    const cityRings = city
      ? cities
          .filter(({ feature }) => feature.id === city.feature.id)
          .map(({ rings }) => rings)
      : [];
    const point = points
      .filter(
        ({ feature }) =>
          !city ||
          cityRings.some((rings) =>
            contains(rings, feature.longitude, feature.latitude),
          ),
      )
      .sort(rank)[0];
    const result = (neighborhood ?? point ?? city)?.feature;
    if (!result) return undefined;
    const { name, latitude, longitude, importance } = result;
    return { name, latitude, longitude, importance };
  };
}

interface Match {
  feature: Feature;
  value: number;
}

function rank(a: Match, b: Match) {
  return (
    a.value - b.value ||
    b.feature.importance - a.feature.importance ||
    a.feature.id - b.feature.id
  );
}
