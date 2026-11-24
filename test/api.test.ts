import { expect, it, vi } from "vitest";
import { createApp } from "../apps/api/src/app";
import { MemoryStore } from "../apps/api/src/memory";
import { locationFor } from "./location-fixture";
import { checkMotion } from "../apps/api/src/admission";
async function setup(name: string | null = "Alice") {
  const store = new MemoryStore();
  const app = createApp(store);
  let cookie: string | undefined;
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    csrf = "1",
  ) => {
    const url = new URL(path, "https://geochalk.com");
    return app({
      method,
      path: url.pathname,
      query: url.searchParams,
      body: body === undefined ? undefined : JSON.stringify(body),
      cookie,
      csrf,
      ip: "127.0.0.1",
    });
  };
  const session = await request("POST", "/sessions", {
    name: name ?? undefined,
  });
  cookie = session.cookies![0].split(";")[0];
  return { store, request, session };
}
it("creates secure persistent cookie identity without exposing a bearer secret", async () => {
  const { request, session } = await setup(null);
  expect(session.cookies![0]).toMatch(
    /__Host-geochalk_guest=.*HttpOnly; SameSite=Lax.*Secure/,
  );
  expect(session.body).not.toHaveProperty("token");
  const identity = (session.body as any).identity;
  expect(identity.name).toMatch(/^(?:[A-Z][a-z]+){3}$/);
  expect(identity.name.length).toBeLessThanOrEqual(24);
  expect((await request("GET", "/me")).body).toEqual(identity);
  const resumed = await request("POST", "/sessions", {});
  expect(resumed.status).toBe(200);
  expect(resumed.body).toEqual(session.body);
  expect((await request("PATCH", "/me", { name: "New name" }, "")).status).toBe(
    403,
  );
});
it("exposes the live endpoint and publishes saved posts", async () => {
  const store = new MemoryStore();
  const publishPost = vi.fn(async () => undefined);
  const app = createApp(store, undefined, {
    webSocketUrl: "wss://example.execute-api.us-west-2.amazonaws.com/live",
    publishPost,
  });
  let cookie: string | undefined;
  const request = async (method: string, path: string, body?: unknown) => {
    const url = new URL(path, "https://geochalk.com");
    const result = await app({
      method,
      path: url.pathname,
      query: url.searchParams,
      body: body === undefined ? undefined : JSON.stringify(body),
      cookie,
      csrf: method === "GET" ? undefined : "1",
      ip: "127.0.0.1",
    });
    if (result.cookies) cookie = result.cookies[0].split(";")[0];
    return result;
  };
  const session = await request("POST", "/sessions", {});
  expect(session.status).toBe(201);
  expect(await request("GET", "/live")).toMatchObject({
    status: 200,
    body: {
      webSocketUrl: "wss://example.execute-api.us-west-2.amazonaws.com/live",
    },
  });
  const posted = await request("POST", "/messages", {
    content: "Live post",
    location: locationFor("9q8yyk8y"),
  });
  expect(posted.status).toBe(201);
  expect(publishPost).toHaveBeenCalledWith(posted.body);
});
it("stores the posting fix independent of the viewed room without storing raw GPS history", async () => {
  const { request, store } = await setup();
  await request("GET", "/posts?geohash=gcpvj&p=5");
  const location = locationFor("9q8yyk8y");
  const result = await request("POST", "/messages", {
    content: "Here",
    room: "u10",
    location,
  });
  expect(result.status).toBe(201);
  expect(result.body).toMatchObject({
    originGeohash: "9q8yyk8y",
    content: "Here",
    latitude: location.latitude,
    longitude: location.longitude,
  });
  const localFeed = await request("GET", "/posts?geohash=9q8yyk8y&p=5");
  expect(localFeed).toMatchObject({
    status: 200,
    body: { count: 1, posts: [result.body] },
  });
  const remoteFeed = await request("GET", "/posts?geohash=gcpvj&p=5");
  expect(remoteFeed).toMatchObject({
    status: 200,
    body: { count: 0, posts: [] },
  });
  expect((await store.list("u10")).posts).toEqual([]);
  expect(store.rooms.size).toBe(9);
  for (const room of store.rooms.values()) {
    const posts = [...room.values()];
    expect(posts).toEqual([result.body]);
    expect(posts[0]).not.toHaveProperty("accuracy");
    expect(posts[0]).not.toHaveProperty("timestamp");
  }
  expect([...store.archive.values()]).toEqual([result.body]);
  expect(JSON.stringify([...store.history.values()])).not.toMatch(
    /latitude|longitude/,
  );
  expect([...store.history.values()][0].observations[0].geohash).toHaveLength(
    5,
  );
});
it("rejects invalid, stale, banned, duplicate, implausible and rate-limited attempts before slot writes", async () => {
  const { request, store, session } = await setup();
  const post = vi.spyOn(store, "post");
  const location = locationFor("9q8yyk8y");
  expect(
    (await request("POST", "/messages", { content: "Missing" })).status,
  ).toBe(400);
  expect(
    (
      await request("POST", "/messages", {
        content: "Stale",
        location: { ...location, timestamp: 0 },
      })
    ).status,
  ).toBe(400);
  expect(
    (await request("POST", "/messages", { content: "bad\u0000", location }))
      .status,
  ).toBe(400);
  expect(post).not.toHaveBeenCalled();
  expect(
    (await request("POST", "/messages", { content: "Hello", location })).status,
  ).toBe(201);
  expect(
    (await request("POST", "/messages", { content: "Hello", location })).status,
  ).toBe(429);
  expect(
    (
      await request("POST", "/messages", {
        content: "Jump",
        location: locationFor("u10j46tj"),
      })
    ).status,
  ).toBe(422);
  expect(post).toHaveBeenCalledTimes(1);
  await store.ban((session.body as any).identity.id, true);
  expect(
    (await request("POST", "/messages", { content: "Banned", location }))
      .status,
  ).toBe(403);
  expect(post).toHaveBeenCalledTimes(1);
});
it("enforces actor and IP counter limits", async () => {
  const store = new MemoryStore();
  for (let i = 0; i < 10; i++) await store.rate("actor", 10, 1000);
  await expect(store.rate("actor", 10, 1000)).rejects.toThrow();
  for (let i = 0; i < 30; i++) await store.rate("ip", 30, 1000);
  await expect(store.rate("ip", 30, 1000)).rejects.toThrow();
});
it("rejects plausible-speed but implausible short round trips using server receipt times", () => {
  const now = Date.now();
  const history = [
    {
      geohash: "9q8yy",
      accuracy: 5000,
      receivedAt: now - 14 * 60000,
      contentHash: "a",
    },
    {
      geohash: "9q9k6",
      accuracy: 5000,
      receivedAt: now - 7 * 60000,
      contentHash: "b",
    },
  ];
  expect(() => checkMotion(history, locationFor("9q8yyk8y"), now)).toThrow(
    "round trip",
  );
});
it("preserves read-only cutover guard", async () => {
  const app = createApp(new MemoryStore(), undefined, { readOnly: true });
  expect(
    (
      await app({
        method: "POST",
        path: "/sessions",
        query: new URLSearchParams(),
        ip: "x",
        csrf: "1",
      })
    ).status,
  ).toBe(503);
});
it("rejects actor limit and dependency failure before writing slots; observations expire", async () => {
  const { request, store, session } = await setup();
  const actor = (session.body as any).identity.id;
  for (let i = 0; i < 10; i++)
    await store.rate(`post:actor:${actor}`, 10, Date.now());
  const post = vi.spyOn(store, "post");
  expect(
    (
      await request("POST", "/messages", {
        content: "Too many",
        location: locationFor("9q8yyk8y"),
      })
    ).status,
  ).toBe(429);
  expect(post).not.toHaveBeenCalled();
  await store.observe(
    actor,
    [{ geohash: "9q8yy", accuracy: 5000, receivedAt: 1000, contentHash: "a" }],
    1000,
  );
  expect(await store.observations(actor, 1801001)).toEqual([]);
});
it("supports reporting and ownership checks with cookie identities", async () => {
  const { request, store } = await setup();
  const result = await request("POST", "/messages", {
    content: "Test moderation",
    location: locationFor("9q8yyk8y"),
  });
  const p = result.body as any;
  expect(
    (
      await request("POST", `/messages/${p.postId}/reports`, {
        originGeohash: p.originGeohash,
        reason: "Please review",
      })
    ).status,
  ).toBe(201);
  expect((await store.reports()).reports[0]).toMatchObject({
    postId: p.postId,
    originGeohash: p.originGeohash,
  });
  expect((await request("GET", "/moderation/reports")).status).toBe(403);
  const anonymous = createApp(store);
  expect(
    (
      await anonymous({
        method: "DELETE",
        path: `/messages/${p.postId}`,
        query: new URLSearchParams({ originGeohash: p.originGeohash }),
        ip: "other",
        csrf: "1",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(
        "DELETE",
        `/messages/${p.postId}?originGeohash=${p.originGeohash}`,
      )
    ).status,
  ).toBe(200);
  expect((await store.list("9")).posts).toEqual([]);
});
it("fails closed on optional location-risk denial before slot writes", async () => {
  const store = new MemoryStore();
  const app = createApp(
    store,
    async () => ({ id: "user:a", name: "A", moderator: false }),
    { riskCheck: async () => "deny" },
  );
  const post = vi.spyOn(store, "post");
  expect(
    (
      await app({
        method: "POST",
        path: "/messages",
        query: new URLSearchParams(),
        token: "verified-by-test",
        csrf: "1",
        ip: "x",
        body: JSON.stringify({
          content: "Risk",
          location: locationFor("9q8yyk8y"),
        }),
      })
    ).status,
  ).toBe(422);
  expect(post).not.toHaveBeenCalled();
});

it("exposes the global room and includes new location-derived posts", async () => {
  const { request } = await setup();
  const result = await request("POST", "/messages", {
    content: "Global test",
    room: "_",
    location: locationFor("9q8yyk8y"),
  });
  expect(result.status).toBe(201);
  const global = await request("GET", "/rooms/_/messages");
  expect(global.status).toBe(200);
  expect((global.body as any).posts).toEqual([result.body]);
  expect((result.body as any).originGeohash).toBe("9q8yyk8y");
  expect((await request("GET", "/rooms/suggest?geohash=_")).body).toMatchObject(
    { room: "_" },
  );
});
