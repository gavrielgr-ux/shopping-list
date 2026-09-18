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
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";

export interface WorkerEnv {
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

/** Compare two secrets by digest, so the comparison does not short-circuit on the first byte. */
async function secretsMatch(left: string, right: string): Promise<boolean> {
  const digest = async (value: string): Promise<string> => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  };
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  return a === b;
}

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
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    // Unauthenticated liveness check, deliberately saying nothing about configuration.
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("shopping-list-mcp-server\n", {
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
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

    if (rest !== "/mcp") {
      return json(404, {
        error: "not_found",
        message: `Nothing is served at ${rest}. The MCP endpoint is /mcp.`
      });
    }

    // Env bindings are not visible to module-scope code, so hand the credential over before the
    // first database call. Everything else has a working default baked in.
    if (env.SHOPPING_LIST_DB_SECRET && !process.env.SHOPPING_LIST_DB_SECRET) {
      process.env.SHOPPING_LIST_DB_SECRET = env.SHOPPING_LIST_DB_SECRET;
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
