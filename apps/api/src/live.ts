import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ancestors, roomSchema, type Post } from "@geochalk/shared";

const tableName = process.env.CONNECTIONS_TABLE_NAME;
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function requiredTable() {
  if (!tableName) throw new Error("Live connections table is not configured.");
  return tableName;
}

export async function connect(connectionId: string, rawRoom?: string | null) {
  const room = roomSchema.parse(rawRoom || "_");
  await docClient.send(
    new PutCommand({
      TableName: requiredTable(),
      Item: {
        connectionId,
        room,
        expiresAt: Math.floor(Date.now() / 1000) + 3 * 60 * 60,
      },
    }),
  );
}

export async function disconnect(connectionId: string) {
  await docClient.send(
    new DeleteCommand({
      TableName: requiredTable(),
      Key: { connectionId },
    }),
  );
}

export async function publishPost(post: Post) {
  const callbackUrl = process.env.WEBSOCKET_MANAGEMENT_URL;
  if (!callbackUrl) return;
  const management = new ApiGatewayManagementApiClient({
    endpoint: callbackUrl,
  });
  const stale: string[] = [];
  const data = Buffer.from(JSON.stringify({ type: "post", post }));
  for (const room of ancestors(post.originGeohash)) {
    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await docClient.send(
        new QueryCommand({
          TableName: requiredTable(),
          IndexName: "RoomIndex",
          KeyConditionExpression: "#room = :room",
          ExpressionAttributeNames: { "#room": "room" },
          ExpressionAttributeValues: { ":room": room },
          ExclusiveStartKey: lastKey,
        }),
      );
      lastKey = page.LastEvaluatedKey;
      const items = page.Items ?? [];
      for (let index = 0; index < items.length; index += 25) {
        await Promise.all(
          items.slice(index, index + 25).map(async (connection) => {
            const connectionId = String(connection.connectionId);
            try {
              await management.send(
                new PostToConnectionCommand({
                  ConnectionId: connectionId,
                  Data: data,
                }),
              );
            } catch (error) {
              if (error instanceof GoneException) stale.push(connectionId);
              else
                console.error(
                  "WebSocket delivery failed",
                  (error as Error).name,
                );
            }
          }),
        );
      }
    } while (lastKey);
  }
  await Promise.all(
    [...new Set(stale)].map((connectionId) => disconnect(connectionId)),
  );
}
