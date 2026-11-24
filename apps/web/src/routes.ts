import {
  centeredRoomSchema,
  encode,
  geohashCenter,
  parseRoomQuery,
  roomFromGeohash,
  roomSchema,
  type Room,
} from "@geochalk/shared";
import type { AreaUnit } from "./presentation";

type CenteredRoomView = Room & { centerGeohash?: string };
export type RoomView = CenteredRoomView | "_";
const centerGeohashLength = 12;

function centerGeohash(room: CenteredRoomView) {
  return room.centerGeohash ?? encode(room.lat, room.lon, centerGeohashLength);
}

export function viewFromPrefix(prefix: string): RoomView {
  roomSchema.parse(prefix);
  return prefix === "_"
    ? "_"
    : {
        ...geohashCenter(prefix),
        precision: prefix.length,
        centerGeohash: prefix,
      };
}

/** Browser URLs use an @ marker; API room IDs stay unchanged. */
export function areaUnitFromSearch(search: string): AreaUnit {
  return new URLSearchParams(search).get("unit") === "meters"
    ? "meters"
    : "miles";
}

export function roomPath(
  room: string | CenteredRoomView,
  unit: AreaUnit = "miles",
): string {
  const query = new URLSearchParams();
  const view = typeof room === "string" ? viewFromPrefix(room) : room;
  let prefix = "";
  if (view !== "_") {
    const { precision } = centeredRoomSchema.parse(view);
    prefix = centerGeohash(view);
    query.set("p", String(precision));
  }
  if (unit === "meters") query.set("unit", unit);
  return `/@${prefix}${query.size ? `?${query}` : ""}`;
}

export function roomFromPath(path: string): string {
  const match = /^\/@([0-9bcdefghjkmnpqrstuvwxyz]*)\/?$/.exec(path);
  return match ? match[1] || "_" : "";
}

export function roomViewFromUrl(
  path: string,
  search: string,
): RoomView | undefined {
  const prefix = roomFromPath(path);
  if (!prefix) return undefined;
  if (prefix === "_") return "_";
  const query = new URLSearchParams(search);
  try {
    if (query.has("p")) {
      return {
        ...roomFromGeohash(prefix, query.get("p")),
        centerGeohash: prefix,
      };
    }
    if (!query.has("lat") && !query.has("lon")) return viewFromPrefix(prefix);
    roomSchema.parse(prefix);
    query.set("precision", String(prefix.length));
    const room = parseRoomQuery(query);
    if (encode(room.lat, room.lon, room.precision) !== prefix) return undefined;
    const center = centerGeohash(room);
    return {
      ...geohashCenter(center),
      precision: room.precision,
      centerGeohash: center,
    };
  } catch {
    return undefined;
  }
}

export function roomFeedPath(room: RoomView): string {
  if (room === "_") return "/rooms/_/messages";
  const query = new URLSearchParams({
    geohash: centerGeohash(room),
    p: String(room.precision),
  });
  return `/posts?${query}`;
}
