import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const tableName =
  process.env.GEOCHALK_PRODUCTION_ARCHIVE_TABLE ??
  "GeochalkWest-PostArchiveV1F59FA1E3-YXLKHJ4Z8C65";
const region = process.env.AWS_REGION ?? "us-west-2";
const limit = Number(process.env.GEOCHALK_LOCAL_SEED_LIMIT ?? 10_000);
const output = resolve(
  process.env.GEOCHALK_LOCAL_SEED_PATH ??
    "artifacts/local-seed/production-posts.json",
);
if (!Number.isInteger(limit) || limit < 1)
  throw new Error("GEOCHALK_LOCAL_SEED_LIMIT must be a positive integer.");

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const posts = [];
let cursor;
let scanned = 0;
do {
  const page = await db.send(
    new ScanCommand({
      TableName: tableName,
      ProjectionExpression:
        "#postId, #originGeohash, #displayName, #content, #createdAt",
      ExpressionAttributeNames: {
        "#postId": "postId",
        "#originGeohash": "originGeohash",
        "#displayName": "displayName",
        "#content": "content",
        "#createdAt": "createdAt",
      },
      ExclusiveStartKey: cursor,
    }),
  );
  scanned += page.ScannedCount ?? 0;
  for (const item of page.Items ?? []) {
    if (
      typeof item.postId !== "string" ||
      typeof item.originGeohash !== "string" ||
      typeof item.displayName !== "string" ||
      typeof item.content !== "string" ||
      typeof item.createdAt !== "string"
    )
      continue;
    posts.push({
      postId: item.postId,
      originGeohash: item.originGeohash,
      displayName: item.displayName,
      content: item.content,
      createdAt: item.createdAt,
    });
  }
  posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (posts.length > limit) posts.length = limit;
  cursor = page.LastEvaluatedKey;
} while (cursor);

await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.partial`;
await writeFile(temporary, `${JSON.stringify(posts, null, 2)}\n`, {
  mode: 0o600,
});
await rename(temporary, output);
await writeFile(
  `${output}.manifest.json`,
  `${JSON.stringify(
    {
      sourceTable: tableName,
      region,
      scannedItems: scanned,
      seededPosts: posts.length,
      fetchedAt: new Date().toISOString(),
      omittedFields: [
        "authorId",
        "sessions",
        "account data",
        "moderation data",
      ],
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(
  `Seeded ${posts.length} recent public posts from ${scanned} archive items into ${output}`,
);
