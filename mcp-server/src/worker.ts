/**
 * Cloudflare Worker entry point: the same tools, reachable over HTTPS.
 *
 * This exists so the Claude mobile app, Cowork and claude.ai can use the server as a custom
 * connector. Those surfaces do not run anything locally: Anthropic's servers connect outward to
 * a URL, so the server has to be publicly reachable rather than a subprocess on a machine.
 *
 * Two deliberate choices:
 *
 *  - Stateless. No `sessionIdGenerator` is passed, so the transport handles each request on its
 *    own with no session to keep alive. That means no Durable Objects, which keeps the whole
 *    thing inside Cloudflare's free tier, and it suits a tool server where every call is
 *    already an independent read or compare-and-swap against the database.
 *  - Fail closed. Without a configured access token the Worker serves nothing, because the
 *    alternative is a public URL that can edit the family's shopping lists.
 *
 * Two interfaces are served, both behind the same token: `/mcp` for MCP clients, and `/api/*`
 * for everything that cannot speak MCP, such as a ChatGPT custom action or an iOS Shortcut.
 *
 * The family's Telegram bot lives here too. Its webhook is the one route outside the token,
 * because Telegram cannot send it; Telegram's own secret header guards it instead, and the bot
 * serves nothing until that secret is configured. See `src/telegram/bot.ts`.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { handleRest } from "./rest.js";
import { secretsMatch } from "./secrets.js";
import { createServer } from "./server.js";
import { handleTelegramAdmin, handleTelegramWebhook } from "./telegram/bot.js";
import type { BotEnv } from "./telegram/config.js";
import type { ExecutionContext } from "./telegram/platform.js";

export interface WorkerEnv extends BotEnv {
  /** Shared secret required on every request. Set with `wrangler secret put`. */
  SHOPPING_LIST_ACCESS_TOKEN?: string;
  /** Optional Firebase credential, so the Worker need not create anonymous users. */
  SHOPPING_LIST_DB_SECRET?: string;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });

/**
 * Pull the caller's token from wherever it was put.
 *
 * A bearer header is the right place for it. A secret path segment is accepted too, because a
 * client that only lets you paste a URL has nowhere else to carry one, and that is the same
 * "unguessable URL" protection the shopping lists themselves already rely on.
 */
function presentedToken(request: Request, url: URL): { token: string | null; rest: string } {
  const header = request.headers.get("authorization");
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const segments = url.pathname.split("/").filter(Boolean);
  if (bearer) return { token: bearer, rest: `/${segments.join("/")}` };
  // Otherwise treat a leading segment as the secret: /<token>/mcp
  if (segments.length >= 2) {
    return { token: segments[0]!, rest: `/${segments.slice(1).join("/")}` };
  }
  return { token: null, rest: `/${segments.join("/")}` };
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Env bindings are not visible to module-scope code, so hand the credential over before the
    // first database call. Everything else has a working default baked in.
    if (env.SHOPPING_LIST_DB_SECRET && !process.env.SHOPPING_LIST_DB_SECRET) {
      process.env.SHOPPING_LIST_DB_SECRET = env.SHOPPING_LIST_DB_SECRET;
    }

    // Unauthenticated liveness check, deliberately saying nothing about configuration.
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("shopping-list-mcp-server\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    // Before the token check: Telegram authenticates with its secret header instead.
    if (url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env, ctx);
    }

    const expected = env.SHOPPING_LIST_ACCESS_TOKEN?.trim();
    if (!expected) {
      // Refusing to serve is the only safe response: anyone who found the URL could otherwise
      // read and rewrite every list.
      return json(503, {
        error: "not_configured",
        message:
          "This deployment has no SHOPPING_LIST_ACCESS_TOKEN set, so it refuses to serve. " +
          "Set one with: wrangler secret put SHOPPING_LIST_ACCESS_TOKEN"
      });
    }

    const { token, rest } = presentedToken(request, url);
    if (!token || !(await secretsMatch(token, expected))) {
      return new Response(
        JSON.stringify({ error: "unauthorized", message: "Missing or incorrect access token." }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            // Point a spec-compliant client at the scheme it should use.
            "WWW-Authenticate": 'Bearer realm="shopping-list"'
          }
        }
      );
    }

    // Owner routes for the Telegram bot: webhook registration and status.
    const telegramResponse = await handleTelegramAdmin(request, rest, url, env);
    if (telegramResponse) return telegramResponse;

    // Plain HTTP interface, for callers that cannot speak MCP.
    const restResponse = await handleRest(request, rest, url);
    if (restResponse) return restResponse;

    if (rest !== "/mcp") {
      return json(404, {
        error: "not_found",
        message: `Nothing is served at ${rest}. The MCP endpoint is /mcp; the HTTP API is under /api/, described by /api/openapi.json.`
      });
    }

    const server = createServer();
    // No sessionIdGenerator: stateless mode, one request at a time, no Durable Object needed.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await transport.close().catch(() => undefined);
    }
  }
};
