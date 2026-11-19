import { roomSchema } from "@geochalk/shared";

/** Browser URLs use an underscore marker; API room IDs stay unchanged. */
export function roomPath(room: string): string {
  const id = roomSchema.parse(room);
  return id === "_" ? "/_" : `/_${id}`;
}

export function roomFromPath(path: string): string {
  const match = /^\/_([0-9bcdefghjkmnpqrstuvwxyz]{0,8})\/?$/.exec(path);
  return match ? match[1] || "_" : "";
}
