import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2,
} from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { createApp } from "./app";
import { DynamoStore } from "./dynamo";
import { configuredGeonameLookup } from "./geoname";
import { connect, disconnect, publishPost } from "./live";
import { z } from "zod";
const roomNameLookup = configuredGeonameLookup(
  process.env.GEOCHALK_GAZETTEER_PATH,
);
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: "id",
  clientId: process.env.USER_POOL_CLIENT_ID!,
});
const app = createApp(
  new DynamoStore(
    process.env.POSTS_TABLE_NAME!,
    process.env.CONTROL_TABLE_NAME!,
    process.env.ARCHIVE_TABLE_NAME!,
  ),
  async (token) => {
    const claims = await verifier.verify(token);
    return {
      id: `user:${claims.sub}`,
      name: typeof claims.nickname === "string" ? claims.nickname : "Member",
      moderator: (claims["cognito:groups"] ?? []).includes("moderators"),
    };
  },
  {
    readOnly: process.env.READ_ONLY === "true",
    roomNameLookup,
    webSocketUrl: process.env.WEBSOCKET_URL,
    publishPost,
  },
);
export const handler = async (
  event: APIGatewayProxyEventV2 | APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResultV2> => {
  if ("connectionId" in event.requestContext) {
    const { connectionId, routeKey } = event.requestContext;
    try {
      if (routeKey === "$connect")
        await connect(connectionId, event.queryStringParameters?.room);
      if (routeKey === "$disconnect") await disconnect(connectionId);
      return { statusCode: 200, body: "ok" };
    } catch (error) {
      if (error instanceof z.ZodError)
        return { statusCode: 400, body: "invalid room" };
      console.error(
        "WebSocket connection handling failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      return { statusCode: 500, body: "connection unavailable" };
    }
  }
  const httpEvent = event as APIGatewayProxyEventV2;
  const result = await app({
    method: httpEvent.requestContext.http.method,
    path: httpEvent.rawPath,
    query: new URLSearchParams(httpEvent.rawQueryString),
    cookie: httpEvent.cookies?.join("; "),
    csrf: httpEvent.headers["x-geochalk-request"],
    token: httpEvent.headers.authorization?.replace(/^Bearer /i, ""),
    body: httpEvent.isBase64Encoded
      ? Buffer.from(httpEvent.body ?? "", "base64").toString()
      : httpEvent.body,
    ip: httpEvent.requestContext.http.sourceIp,
  });
  return {
    statusCode: result.status,
    cookies: result.cookies,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(result.body),
  };
};
