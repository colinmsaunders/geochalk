import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { alphabet, roomSchema } from "@geochalk/shared";
import { createFineLookup } from "./fine-geoname";

export interface Geoname {
  name: string;
  latitude: number;
  longitude: number;
  importance: number;
}

export function createGeonameLookup(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA query_only=ON");
  const version = db
    .prepare("SELECT value FROM metadata WHERE key='schema_version'")
    .get() as { value?: string } | undefined;
  if (version?.value !== "1") {
    db.close();
    throw new Error("Unsupported GeoChalk gazetteer schema version.");
  }

  const lookup = db.prepare(`
    SELECT p.name, p.latitude, p.longitude, p.importance
    FROM room_anchors a JOIN places p ON p.id=a.place_id
    WHERE a.geohash_key=?
  `);
  const cache = new Map<string, Geoname | null>();
  const fineLookup = createFineLookup(db);
  return (room: string): Geoname | undefined => {
    const prefix = roomSchema.parse(room);
    if (prefix === "_") return undefined;
    const cached = cache.get(prefix);
    if (cached !== undefined) {
      cache.delete(prefix);
      cache.set(prefix, cached);
      return cached ?? undefined;
    }

    let result: Geoname | undefined;
    for (let parent = prefix; parent.length > 0; parent = parent.slice(0, -1)) {
      let key = 1; // Sentinel bit encodes precision, including leading zeroes.
      for (const character of parent) {
        key = key * 32 + alphabet.indexOf(character);
      }
      const row =
        (lookup.get(key) as Geoname | undefined) ??
        (parent.length === 7 ? fineLookup?.(parent) : undefined);
      if (row) {
        result = row;
        break;
      }
    }
    cache.set(prefix, result ?? null);
    if (cache.size > 100_000) cache.delete(cache.keys().next().value!);
    return result;
  };
}

export function configuredGeonameLookup(path?: string) {
  return path && existsSync(path) ? createGeonameLookup(path) : undefined;
}
