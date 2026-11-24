import { z } from "zod";

export const alphabet = "0123456789bcdefghjkmnpqrstuvwxyz";
export const geohashSchema = z.string().regex(/^[0-9bcdefghjkmnpqrstuvwxyz]+$/);

export function encode(lat: number, lon: number, precision = 8): string {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180 ||
    !Number.isSafeInteger(precision) ||
    precision < 0
  )
    throw new Error("Invalid coordinates or precision");
  if (precision === 0) return "_";
  let south = -90,
    north = 90,
    west = -180,
    east = 180,
    even = true,
    bits = 0,
    value = 0,
    hash = "";
  while (hash.length < precision) {
    const mid = even ? (west + east) / 2 : (south + north) / 2;
    const high = (even ? lon : lat) >= mid;
    value = (value << 1) + (high ? 1 : 0);
    if (even) {
      if (high) west = mid;
      else east = mid;
    } else {
      if (high) south = mid;
      else north = mid;
    }
    even = !even;
    if (++bits === 5) {
      hash += alphabet[value];
      bits = 0;
      value = 0;
    }
  }
  return hash;
}
export function bounds(room: string) {
  if (room !== "_") geohashSchema.parse(room);
  let south = -90,
    north = 90,
    west = -180,
    east = 180,
    even = true;
  for (const c of room === "_" ? "" : room) {
    const value = alphabet.indexOf(c);
    for (let mask = 16; mask; mask >>= 1) {
      const mid = even ? (west + east) / 2 : (south + north) / 2;
      if (even) {
        if (value & mask) west = mid;
        else east = mid;
      } else {
        if (value & mask) south = mid;
        else north = mid;
      }
      even = !even;
    }
  }
  return { south, north, west, east };
}
