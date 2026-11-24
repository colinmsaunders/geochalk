import { expect, it } from "vitest";
import {
  roomFromPath,
  roomFeedPath,
  roomPath,
  roomViewFromUrl,
} from "../apps/web/src/routes";
import {
  moveRoom,
  zoomInRoom,
  zoomOutRoom,
} from "../apps/web/src/presentation";
import { ancestors, command, geohashCenter } from "@geochalk/shared";

it("round-trips room navigation at every level through @ URLs", () => {
  for (const room of [...ancestors("9q8yyk8y"), "qr"]) {
    const url = new URL(roomPath(room), "https://geochalk.com");
    expect(roomFromPath(url.pathname)).toBe(room);
    expect(roomFromPath(url.pathname + "/")).toBe(room);
  }
  expect(roomPath("_")).toBe("/@");
  expect(roomPath("9q8yu")).toBe("/@9q8yu?p=5");
  expect(roomPath("qr")).toBe("/@qr?p=2");
  const out = command("/out", roomFromPath("/@q"));
  expect(out).toEqual({ kind: "go", room: "_" });
  if (out?.kind === "go") expect(roomPath(out.room)).toBe("/@");
});

it("round-trips a fixed center through bookmarks and preserves it when zooming", () => {
  const room = { lat: 37.775, lon: -122.419, precision: 5 };
  const url = new URL(roomPath(room), "https://geochalk.com");
  const decoded = roomViewFromUrl(url.pathname, url.search);
  if (!decoded || decoded === "_") throw Error("Expected a centered room");
  const center = url.pathname.slice(2);
  expect(center).toHaveLength(12);
  expect(url.search).toBe("?p=5");
  expect(decoded.lat).toBeCloseTo(room.lat, 6);
  expect(decoded.lon).toBeCloseTo(room.lon, 6);
  expect(roomFeedPath(decoded)).toBe(`/posts?geohash=${center}&p=5`);
  expect(roomPath(zoomInRoom(decoded))).toBe(`/@${center}?p=6`);
  expect(roomViewFromUrl("/@9q8yy", "")).toEqual({
    ...geohashCenter("9q8yy"),
    precision: 5,
    centerGeohash: "9q8yy",
  });
  expect(roomViewFromUrl("/@9q8yy", "?lat=37.775&lon=-122.419")).toEqual(
    decoded,
  );
  const longCenter = center.repeat(3);
  expect(roomViewFromUrl(`/@${longCenter}`, "?p=8")).toEqual({
    ...geohashCenter(longCenter),
    precision: 8,
    centerGeohash: longCenter,
  });
  expect(roomViewFromUrl(`/@${longCenter}`, "?p=9")).toBeUndefined();
  expect(roomViewFromUrl(`/@${longCenter}`, "")).toBeUndefined();
  expect(roomViewFromUrl("/@9q8yy", "?lat=0&lon=0")).toBeUndefined();
  expect(zoomInRoom(room)).toEqual({ ...room, precision: 6 });
  expect(zoomOutRoom(room)).toEqual({ ...room, precision: 4 });
  expect(
    moveRoom({ lat: 89.99, lon: 179.99, precision: 5 }, 1, 1),
  ).toMatchObject({
    lat: 90,
    lon: expect.closeTo(-179.98802734375),
    precision: 5,
  });
});

it("does not interpret other pages or malformed URLs as rooms", () => {
  for (const path of [
    "/",
    "/qr",
    "/about",
    "/9q8yu",
    "/g/9q8yu",
    "/api/rooms/_/messages",
    "/@_",
    "/@a",
    "/@QR",
    "/@9q8yu/extra",
    "/@9q8yu//",
  ])
    expect(roomFromPath(path)).toBe("");
  for (const room of ["", "_qr", "a", "9q8yyk8yy", "../about"])
    expect(() => roomPath(room)).toThrow();
});
