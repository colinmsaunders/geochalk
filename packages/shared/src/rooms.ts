import { z } from "zod";
import { bounds, encode, type Post } from "./index";

const coordinatesSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export const centeredRoomSchema = coordinatesSchema.extend({
  precision: z.number().int().min(1).max(8),
});
export type Room = z.infer<typeof centeredRoomSchema>;
export type Coordinates = z.infer<typeof coordinatesSchema>;

export interface RoomBounds {
  south: number;
  north: number;
  west: number;
  east: number;
  crossesAntimeridian: boolean;
}
export interface RoomPosts extends Room {
  bounds: RoomBounds;
  prefixes: string[];
  posts: Post[];
  count: number;
}

export function wrapLongitude(lon: number): number {
  const value = lon % 360;
  if (value >= 180) return value - 360;
  if (value < -180) return value + 360;
  return value;
}

export function geohashCenter(prefix: string): Coordinates {
  const cell = bounds(prefix);
  return {
    lat: (cell.south + cell.north) / 2,
    lon: (cell.west + cell.east) / 2,
  };
}

export function centeredRoomGeometry(room: Room) {
  const { lat, lon, precision } = centeredRoomSchema.parse(room);
  const cell = bounds(encode(lat, lon, precision));
  const height = cell.north - cell.south;
  const width = cell.east - cell.west;
  const south = Math.max(-90, lat - height / 2);
  const north = Math.min(90, lat + height / 2);
  const west = lon - width / 2;
  const east = lon + width / 2;
  // Enumerate only cells with positive-area overlap. Grid lines are multiples
  // of binary fractions, so compare the edges directly at aligned boundaries.
  const prefixes: string[] = [];
  for (const y of intersectingCells(south, north, -90, height)) {
    for (const x of intersectingCells(west, east, -180, width)) {
      prefixes.push(encode(y, wrapLongitude(x), precision));
    }
  }
  return {
    bounds: {
      south,
      north,
      west: wrapLongitude(west),
      east: east === 180 ? 180 : wrapLongitude(east),
      crossesAntimeridian: west < -180 || east > 180,
    } satisfies RoomBounds,
    prefixes,
  };
}

function intersectingCells(
  start: number,
  end: number,
  origin: number,
  span: number,
) {
  const centers: number[] = [];
  let edge = origin + Math.floor((start - origin) / span) * span;
  // Floating point cancellation near the zero meridian can round the index up.
  if (edge > start) edge -= span;
  for (; edge < end; edge += span) {
    if (edge + span > start) centers.push(edge + span / 2);
  }
  return centers;
}

export function roomContains(room: RoomBounds, { lat, lon }: Coordinates) {
  return (
    lat >= room.south &&
    (lat < room.north || (lat === 90 && room.north === 90)) &&
    (room.crossesAntimeridian
      ? lon >= room.west || lon < room.east
      : lon >= room.west &&
        (lon < room.east || (lon === 180 && room.east === 180)))
  );
}

export function postCoordinates(post: Post): Coordinates {
  if (post.latitude !== undefined && post.longitude !== undefined) {
    return { lat: post.latitude, lon: post.longitude };
  }
  return geohashCenter(post.originGeohash);
}

export function parseRoomQuery(query: URLSearchParams) {
  const number = (key: string) => {
    const text = query.get(key);
    return text && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)
      ? Number(text)
      : NaN;
  };
  return centeredRoomSchema.parse({
    lat: number("lat"),
    lon: number("lon"),
    precision: number("precision"),
  });
}
