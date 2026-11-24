# geochalk

Read anywhere. Post from where you are. A TypeScript monorepo for guest-first, geographically nested chat on AWS.

Live at **https://geochalk.com**, with the application in **us-west-2**, AWS account **451261323611**. CloudFront is global and its certificate remains in us-east-1.

## Run locally

Requires Node.js 22.12+ and npm.

```sh
npm ci
npm run seed:production # optional: copy public posts from the prod archive into gitignored local data
npm run dev
```

Open **http://127.0.0.1:5173**. The local API uses an in-memory store seeded from `artifacts/local-seed/production-posts.json` when present; data resets when the API restarts. The seed contains recent public post fields only, omits author IDs and account/session data, and is ignored by Git. `npm run seed:production` needs AWS credentials for the production account and can be bounded with `GEOCHALK_LOCAL_SEED_LIMIT`.

The generated read-only room gazetteer lives at `artifacts/room-descriptions/geochalk-gazetteer-v1-20261121.sqlite`. Local API lookups use it automatically; set `GEOCHALK_GAZETTEER_PATH` to use another database. Room-name lookup falls back through parent geohash prefixes when an exact anchor is not precomputed. Opening `/` asks for location and suggests a room; if location is denied, enter a geohash or choose a city.

```sh
npm test
npm run build
npm run synth
```

`build` includes strict TypeScript checking. `synth` requires the frontend build first. No cloud deployment is performed by these commands.

## Included in Milestone 1

- React/Vite frontend with fixed room centers in shareable URLs such as `/@9q8yyk9pqd3s?p=5`. The geohash encodes the center and `p` sets the zoom from 1 to 8. Earth stays at `/@`.
- The navigation row shows the side length of a square with the same area, rounded down to whole feet. Add `unit=meters` to the room URL query to display whole meters.
- Public room reads, WebSocket updates, guest sessions, optional Cognito email accounts and slash commands. Room navigation preserves the center on zoom and moves by half a cell with each arrow.
- Server-derived precision-8 posting origins, fresh location checks, persistent HttpOnly guest cookies, and short-lived coarse observations for motion checks.
- Nine unconditional denormalized writes into independent rooms. Each room has 256 random hexadecimal slots; collisions replace posts without chronological eviction or post TTL.
- Append-only storage of each original post, including after room eviction or deletion; room reads return all surviving posts, up to 256.
- Full-room query pagination, timestamp sorting, per-identity/IP limits, duplicate/content/motion admission checks, reporting and replacement-safe moderation deletion.
- CDK: HTTP API, Lambda, separate room/control/archive DynamoDB tables, Cognito, private S3, CloudFront, optional Route 53/ACM, logs, error alarms and storage metrics dashboard.
- Same API application in local and Lambda adapters; behavior tests and infrastructure assertions.

See [architecture and DynamoDB schema](docs/architecture.md), [API contracts](docs/api.md), and [deployment instructions](docs/deployment.md), and [traffic cost estimates](docs/costs.md).

## Layout

| Directory         | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `apps/web`        | React UI, Cognito account flows, slash commands                      |
| `apps/api`        | Application routes, Lambda/local adapters, DynamoDB/in-memory stores |
| `packages/shared` | Validation, geohash geometry, smart zoom, shared types               |
| `infra`           | AWS CDK application                                                  |
| `test`            | Geographic, API behavior, and infrastructure tests                   |

## Scope and next milestone

Geochalk architecture/schema v1 is deployed with fresh data in account 451261323611, with the application in us-west-2. New `PostsV1` and `ControlV1` tables use the existing random-slot model. Prior deployments are retained without copying posts or accounts; see the deployment guide for rollout status.

Remaining launch work: load/cost testing, alert routing, operational moderation, verified viewer-IP protection behind CloudFront, and broader content abuse handling. Browser GPS is spoofable; coarse motion checks can race. Full-room reads and durable moderation markers have growing read costs. Broad prefixes may become hot. These tradeoffs are documented in the architecture.

Other limits include API-only moderator tools, no password-reset/token-refresh UI, no account/guest merging, attachments, full-text search or map tiles. Posting makes the reported latitude and longitude public and retains them in the append-only archive. Reading a room does not require location permission. Optional Cognito tokens remain in localStorage. Guest identity uses a secure cookie.

## Commands

`/join 9q8yy`, `/out`, `/in b`, `/here`, `/nick Your Name` (guests), `/help`.

New guests and account signups start with a random display name such as `CuriousRedGopher`: an adjective, color, and animal, each a single capitalized word. Guests can change it with `/nick`, and account signups can edit it before registering. Display names are not unique account identifiers.

Enter sends. Shift+Enter creates a newline. Local sessions and limits reset with the local API process.

## Geographic room descriptions

The offline Python [gazetteer builder and read-only runtime](packages/room-descriptions/README.md) precompute geographic anchors for rooms at precisions 1–4 and resolve precision 5 through its parent. See [build measurements](docs/room-descriptions.md). This module is independent of the chat API deployment.
