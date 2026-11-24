import { describe, expect, it, vi } from "vitest";
import {
  bounds,
  centeredRoomGeometry,
  encode,
  encodePostId,
  geohashCenter,
  parseRoomQuery,
  roomContains,
  type Post,
} from "@geochalk/shared";
import { getRoomPosts } from "../apps/api/src/store";
import { MemoryStore } from "../apps/api/src/memory";

function post(cell: number, slot: number, lat: number, lon: number): Post {
  const id = new Uint8Array(20);
  id[0] = slot;
  id[1] = cell;
  return {
    postId: encodePostId(id),
    originGeohash: encode(lat, lon),
    latitude: lat,
    longitude: lon,
    content: "Hello",
    authorId: "guest:a",
    displayName: "Guest",
    createdAt: new Date(
      Date.UTC(2026, 0, 1) + (cell * 256 + slot) * 1000,
    ).toISOString(),
  };
}

describe("centered room geometry", () => {
  it.each(Array.from({ length: 8 }, (_, i) => i + 1))(
    "matches the dimensions of a precision-%i geohash",
    (precision) => {
      const room = { lat: 37.775, lon: -122.419, precision };
      const cell = bounds(encode(room.lat, room.lon, precision));
      const geometry = centeredRoomGeometry(room);
      const b = geometry.bounds;
      expect(b.north - b.south).toBeCloseTo(cell.north - cell.south, 12);
      expect(b.east - b.west).toBeCloseTo(cell.east - cell.west, 12);
      expect((b.north + b.south) / 2).toBeCloseTo(room.lat, 12);
      expect((b.east + b.west) / 2).toBeCloseTo(room.lon, 12);
      expect(geometry.prefixes).toHaveLength(4);
      expect(new Set(geometry.prefixes).size).toBe(4);
      expect(centeredRoomGeometry({ ...room })).toEqual(geometry);
    },
  );

  it("queries four quadrants at a grid intersection and only the aligned cells otherwise", () => {
    const room = { lat: 0, lon: 0, precision: 5 };
    const expected = [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ].map(([y, x]) => encode(y / 1000, x / 1000, 5));
    expect(centeredRoomGeometry(room).prefixes).toEqual(expected);
    const center = geohashCenter(expected[3]);
    expect(centeredRoomGeometry({ ...center, precision: 5 }).prefixes).toEqual([
      expected[3],
    ]);
    expect(centeredRoomGeometry({ ...room, lat: center.lat }).prefixes).toEqual(
      expected.slice(2),
    );
  });

  it.each([-180, -179.999, 179.999, 180])(
    "wraps cells and filtering near longitude %s",
    (lon) => {
      const geometry = centeredRoomGeometry({ lat: 0, lon, precision: 5 });
      expect(geometry.bounds.crossesAntimeridian).toBe(true);
      expect(geometry.prefixes).toContain(encode(0, 179.999, 5));
      expect(geometry.prefixes).toContain(encode(0, -179.999, 5));
      expect(roomContains(geometry.bounds, { lat: 0, lon: 180 })).toBe(true);
      expect(roomContains(geometry.bounds, { lat: 0, lon: -180 })).toBe(true);
      expect(roomContains(geometry.bounds, { lat: 0, lon: 0 })).toBe(false);
    },
  );

  it.each([-90, -89.999, 89.999, 90])(
    "clips latitudes near %s without inventing neighbors",
    (lat) => {
      const geometry = centeredRoomGeometry({ lat, lon: 180, precision: 5 });
      expect(geometry.prefixes).toHaveLength(2);
      expect(geometry.prefixes).toEqual([
        encode(lat, 179.999, 5),
        encode(lat, -179.999, 5),
      ]);
      expect(
        roomContains(geometry.bounds, { lat: lat > 0 ? 90 : -90, lon: 180 }),
      ).toBe(true);
      expect(roomContains(geometry.bounds, { lat: 0, lon: 180 })).toBe(false);
    },
  );

  it.each([
    "lat=&lon=0&precision=5",
    "lat=0&lon=0",
    "lat=91&lon=0&precision=5",
    "lat=0&lon=-181&precision=5",
    "lat=0&lon=0&precision=5.5",
    "lat=0&lon=0&precision=9",
    "lat=0&lon=0&precision=0",
    "lat=0x1&lon=0&precision=5",
    "geohash=9q8yy",
    "geohash=9q8yy&p=0",
    "geohash=9q8yy&p=9",
    "geohash=9q8yy&p=2.5",
    "geohash=bad&p=5",
    "p=5",
  ])("rejects invalid query %s", (input) => {
    expect(() => parseRoomQuery(new URLSearchParams(input))).toThrow();
  });
});

describe("combining centered room slots", () => {
  const room = { lat: 0, lon: 0, precision: 5 };

  it("reads in parallel, filters exact coordinates, deduplicates and sorts sparse cells", async () => {
    const store = new MemoryStore();
    const { bounds, prefixes } = centeredRoomGeometry(room);
    const older = post(0, 8, -0.01, -0.01);
    const newer = post(1, 8, 0.01, 0.01);
    const outside = post(1, 9, bounds.north + 0.001, 0.01);
    // Both sides of this rectangle edge land in the same storage prefix.
    expect(outside.originGeohash.slice(0, 5)).toBe(
      newer.originGeohash.slice(0, 5),
    );
    const legacy = post(0, 9, -0.01, -0.01);
    delete legacy.latitude;
    delete legacy.longitude;
    const results = [[older, legacy], [], [older], [newer, outside]];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const listSlots = vi
      .spyOn(store, "listSlots")
      .mockImplementation(async (prefix) => {
        await gate;
        return results[prefixes.indexOf(prefix)];
      });
    const request = getRoomPosts(store, room);
    expect(listSlots.mock.calls.flat()).toEqual(prefixes);
    finish();
    const feed = await request;
    expect(feed).toEqual({
      ...room,
      bounds,
      prefixes,
      posts: [newer, legacy, older],
      count: 3,
    });
  });

  it("returns only the newest 256 across four full cells, with independent slots", async () => {
    const store = new MemoryStore();
    // Interleave timestamps so the cap still includes posts from every cell,
    // including posts with the same slot number in different partitions.
    const posts = [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ].flatMap(([y, x], cell) =>
      Array.from({ length: 256 }, (_, slot) => ({
        ...post(cell, slot, y / 100, x / 100),
        createdAt: new Date(
          Date.UTC(2026, 0, 1) + (slot * 4 + cell) * 1000,
        ).toISOString(),
      })),
    );
    for (const item of posts) await store.post(item);
    const read = vi.spyOn(store, "listSlots");
    const feed = await getRoomPosts(store, room);
    expect(read).toHaveBeenCalledTimes(4);
    expect(feed.count).toBe(256);
    expect(feed.posts).toEqual(
      posts
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 256),
    );
    expect(
      new Set(feed.posts.map((item) => item.originGeohash.slice(0, 5))).size,
    ).toBe(4);
    expect(await getRoomPosts(store, room)).toEqual(feed);
  });

  it("returns an empty response without expanding the search", async () => {
    const store = new MemoryStore();
    const read = vi.spyOn(store, "listSlots");
    const centered = { ...geohashCenter("9q8yy"), precision: 5 };
    expect(await getRoomPosts(store, centered)).toMatchObject({
      prefixes: ["9q8yy"],
      posts: [],
      count: 0,
    });
    expect(read.mock.calls).toEqual([["9q8yy"]]);
  });

  it("keeps overlapping posts across a grid line and applies out-of-bounds overwrites locally", async () => {
    const store = new MemoryStore();
    const west = post(0, 8, 0.01, -0.01);
    const east = post(1, 8, 0.01, 0.01);
    await store.post(west);
    await store.post(east);
    const left = { ...room, lon: -0.00001 };
    const right = { ...room, lon: 0.00001 };
    expect((await getRoomPosts(store, left)).posts).toEqual([east, west]);
    expect((await getRoomPosts(store, right)).posts).toEqual([east, west]);

    const outside = post(2, 8, 0.03, 0.01);
    expect(outside.originGeohash.slice(0, 5)).toBe(
      east.originGeohash.slice(0, 5),
    );
    await store.post(outside);
    expect((await getRoomPosts(store, left)).posts).toEqual([west]);
    expect(await store.get(east.originGeohash, east.postId)).toEqual(east);
  });
});
