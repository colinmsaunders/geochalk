import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Post } from "@geochalk/shared";
import { createApp } from "./app";
import { configuredGeonameLookup } from "./geoname";
import { MemoryStore } from "./memory";
const gazetteerPath =
  process.env.GEOCHALK_GAZETTEER_PATH ??
  resolve("artifacts/room-descriptions/geochalk-gazetteer-v1-20261121.sqlite");
const seedPath =
  process.env.GEOCHALK_LOCAL_SEED_PATH ??
  resolve("artifacts/local-seed/production-posts.json");
const seedPosts = existsSync(seedPath)
  ? (
      JSON.parse(readFileSync(seedPath, "utf8")) as Omit<Post, "authorId">[]
    ).map((post) => ({ ...post, authorId: `seed:${post.postId}` }))
  : [];
const store = new MemoryStore(seedPosts);
console.log(`Loaded ${seedPosts.length} local post seeds.`);
const app = createApp(store, undefined, {
  insecureLocalCookie: true,
  roomNameLookup: configuredGeonameLookup(gazetteerPath),
});
createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  if (req.url === "/config.json") {
    res.end(JSON.stringify({ apiUrl: "/api", local: true }));
    return;
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16000) {
      res.writeHead(413);
      res.end(JSON.stringify({ error: "Request too large." }));
      return;
    }
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const result = await app({
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    body,
    cookie: req.headers.cookie,
    csrf: req.headers["x-geochalk-request"] as string | undefined,
    token: req.headers.authorization?.replace(/^Bearer /i, ""),
    ip: req.socket.remoteAddress ?? "local",
  });
  if (result.cookies) res.setHeader("set-cookie", result.cookies);
  res.writeHead(result.status);
  res.end(JSON.stringify(result.body));
}).listen(3001, "127.0.0.1", () =>
  console.log(
    "Local API http://127.0.0.1:3001 — in-memory data, no AWS credentials needed",
  ),
);
