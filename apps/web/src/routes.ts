import {
  centeredRoomSchema,
  encode,
  geohashCenter,
  parseRoomQuery,
  roomSchema,
  type Room,
} from "@geochalk/shared";

export type RoomView = Room | "_";

export function viewFromPrefix(prefix: string): RoomView {
  roomSchema.parse(prefix);
  return prefix === "_"
    ? "_"
    : { ...geohashCenter(prefix), precision: prefix.length };
}

/** Browser URLs use an @ marker; API room IDs stay unchanged. */
export function roomPath(room: string | Room): string {
  if (typeof room === "string") {
    const id = roomSchema.parse(room);
    return id === "_" ? "/@" : `/@${id}`;
  }
  const { lat, lon, precision } = centeredRoomSchema.parse(room);
  return `/@${encode(lat, lon, precision)}?${new URLSearchParams({ lat: String(lat), lon: String(lon) })}`;
}

export function roomFromPath(path: string): string {
  const match = /^\/@([0-9bcdefghjkmnpqrstuvwxyz]{0,8})\/?$/.exec(path);
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
  if (!query.has("lat") && !query.has("lon")) return viewFromPrefix(prefix);
  query.set("precision", String(prefix.length));
  try {
    const room = parseRoomQuery(query);
    return encode(room.lat, room.lon, room.precision) === prefix
      ? room
      : undefined;
  } catch {
    return undefined;
  }
}
