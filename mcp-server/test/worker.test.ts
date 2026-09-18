import assert from "node:assert/strict";
import test from "node:test";
import worker, { type WorkerEnv } from "../src/worker.js";

const TOKEN = "s3cret-access-token";

const call = (path: string, env: WorkerEnv, init: RequestInit = {}): Promise<Response> =>
  worker.fetch(new Request(`https://example.workers.dev${path}`, init), env);

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }
});

const mcpHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream"
};

test("the health endpoint needs no token and leaks no configuration", async () => {
  const response = await call("/", {});
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /shopping-list-mcp-server/);
  // It must not reveal whether a token is set, or anything about the database.
  assert.doesNotMatch(text, /token|firebase|secret/i);
});

test("a deployment with no access token configured refuses to serve", async () => {
  // Failing closed is the only safe default: the alternative is a public URL that can rewrite
  // every list for anyone who finds it.
  const response = await call("/mcp", {}, { method: "POST", headers: mcpHeaders, body: initializeBody });
  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: string; message: string };
  assert.equal(body.error, "not_configured");
  assert.match(body.message, /wrangler secret put SHOPPING_LIST_ACCESS_TOKEN/);
});

test("a request with no token is rejected", async () => {
  const response = await call(
    "/mcp",
    { SHOPPING_LIST_ACCESS_TOKEN: TOKEN },
    { method: "POST", headers: mcpHeaders, body: initializeBody }
  );
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/);
});

test("a request with the wrong token is rejected", async () => {
  const response = await call(
    "/mcp",
    { SHOPPING_LIST_ACCESS_TOKEN: TOKEN },
    { method: "POST", headers: { ...mcpHeaders, Authorization: "Bearer wrong" }, body: initializeBody }
  );
  assert.equal(response.status, 401);
});

test("a token that is a prefix of the real one is rejected", async () => {
  const response = await call(
    "/mcp",
    { SHOPPING_LIST_ACCESS_TOKEN: TOKEN },
    {
      method: "POST",
      headers: { ...mcpHeaders, Authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      body: initializeBody
    }
  );
  assert.equal(response.status, 401);
});

test("a bearer token is accepted and the MCP handshake completes", async () => {
  const response = await call(
    "/mcp",
    { SHOPPING_LIST_ACCESS_TOKEN: TOKEN },
    { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${TOKEN}` }, body: initializeBody }
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result?: { serverInfo?: { name?: string } } };
  assert.equal(body.result?.serverInfo?.name, "shopping-list-mcp-server");
});

test("a secret path segment is accepted, for clients that can only carry a URL", async () => {
  const response = await call(
    `/${TOKEN}/mcp`,
    { SHOPPING_LIST_ACCESS_TOKEN: TOKEN },
    { method: "POST", headers: mcpHeaders, body: initializeBody }
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result?: { serverInfo?: { name?: string } } };
  assert.equal(body.result?.serverInfo?.name, "shopping-list-mcp-server");
});

test("an authenticated request to an unknown path is a 404, not a silent success", async () => {
  const response = await call(
    "/something-else",
    { SHOPPING_LIST_ACCESS_TOKEN: TOKEN },
    { method: "POST", headers: { ...mcpHeaders, Authorization: `Bearer ${TOKEN}` }, body: initializeBody }
  );
  assert.equal(response.status, 404);
});

test("the wrong path under a secret segment is a 404", async () => {
  const response = await call(
    `/${TOKEN}/nope`,
    { SHOPPING_LIST_ACCESS_TOKEN: TOKEN },
    { method: "POST", headers: mcpHeaders, body: initializeBody }
  );
  assert.equal(response.status, 404);
});
