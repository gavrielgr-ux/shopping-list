import assert from "node:assert/strict";
import test from "node:test";
import { installFakeRtdb } from "./fake-rtdb.js";
import { LIST_ID, LIST_PATH, seedList } from "./harness.js";
import worker, { type WorkerEnv } from "../src/worker.js";

const TOKEN = "rest-access-token";
const env: WorkerEnv = { SHOPPING_LIST_ACCESS_TOKEN: TOKEN };

const call = (
  method: string,
  path: string,
  body?: unknown
): Promise<Response> =>
  worker.fetch(
    new Request(`https://example.workers.dev${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
    }),
    env
  );

const withDb = async <T,>(run: () => Promise<T>, options = {}): Promise<T> => {
  const rtdb = installFakeRtdb({ data: { [LIST_PATH]: seedList() }, ...options });
  try {
    return await run();
  } finally {
    rtdb.restore();
  }
};

test("the HTTP API is behind the same token as MCP", async () => {
  const rtdb = installFakeRtdb({ data: { [LIST_PATH]: seedList() } });
  try {
    const response = await worker.fetch(
      new Request("https://example.workers.dev/api/list"),
      env
    );
    assert.equal(response.status, 401);
  } finally {
    rtdb.restore();
  }
});

test("GET /api/list returns the list as JSON", async () => {
  await withDb(async () => {
    const response = await call("GET", "/api/list");
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      name: string;
      progress: { done: number; total: number };
      categories: { title: string; items: { name: string }[] }[];
    };
    assert.equal(body.name, "רשימת קניות");
    assert.deepEqual(body.progress, { done: 1, total: 5, percent: 20 });
    assert.equal(body.categories.length, 2);
  });
});

test("GET /api/list honours pending_only and category", async () => {
  await withDb(async () => {
    const pending = (await (await call("GET", "/api/list?pending_only=true")).json()) as {
      categories: { items: { name: string }[] }[];
    };
    assert.ok(!JSON.stringify(pending).includes("תפוח עץ"), "bought items must be omitted");

    const single = (await (await call("GET", "/api/list?category=חלב")).json()) as {
      categories: { title: string }[];
    };
    assert.equal(single.categories.length, 1);
    assert.equal(single.categories[0]?.title, "חלב וביצים");
  });
});

test("POST /api/items accepts plain strings, which is what a Shortcut sends", async () => {
  await withDb(async () => {
    const response = await call("POST", "/api/items", {
      items: ["לחם", "חומוס"],
      category: "מזווה ורטבים"
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; changed: string[]; progress: { total: number } };
    assert.equal(body.ok, true);
    assert.equal(body.progress.total, 7);
    assert.ok(body.changed.some(line => line.includes("לחם")));
  });
});

test("POST /api/items also accepts objects with notes and per-item categories", async () => {
  await withDb(async () => {
    const response = await call("POST", "/api/items", {
      items: [
        { name: "סוכר", note: "2 ק״ג", category: "אפייה" },
        "גבינה"
      ],
      category: "חלב וביצים"
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { changed: string[] };
    assert.ok(body.changed.some(line => line.includes("2 ק״ג")));
    assert.ok(body.changed.some(line => line.includes('created category "אפייה"')));
  });
});

test("POST /api/items/check ticks items off by loose name", async () => {
  await withDb(async () => {
    const response = await call("POST", "/api/items/check", { items: ["חָלָב", "גזר"] });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { progress: { done: number } };
    assert.equal(body.progress.done, 3);
  });
});

test("POST /api/items/check with all=false resets the list", async () => {
  await withDb(async () => {
    const body = (await (
      await call("POST", "/api/items/check", { all: true, checked: false })
    ).json()) as { progress: { done: number } };
    assert.equal(body.progress.done, 0);
  });
});

test("POST /api/items/remove deletes rows", async () => {
  await withDb(async () => {
    const body = (await (
      await call("POST", "/api/items/remove", { items: ["ביצים"] })
    ).json()) as { changed: string[] };
    assert.ok(body.changed.some(line => line.includes('removed "ביצים"')));
  });
});

test("POST /api/reset unticks by default and guards mode=remove", async () => {
  await withDb(async () => {
    const untick = (await (await call("POST", "/api/reset", {})).json()) as {
      changed: string[];
      progress: { done: number };
    };
    assert.equal(untick.progress.done, 0);
    assert.ok(untick.changed[0]?.includes("cleared the tick mark"));
  });

  await withDb(async () => {
    const response = await call("POST", "/api/reset", { mode: "remove" });
    // The confirmation guard is the tool's own, so it survives the HTTP layer.
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, "request_failed");
    assert.match(body.message, /confirm=true/);
  });
});

test("GET /api/link returns a pasteable message", async () => {
  await withDb(async () => {
    const body = (await (await call("GET", "/api/link?include_progress=true")).json()) as {
      url: string;
      message: string;
    };
    assert.equal(body.url, `https://gavrielgr-ux.github.io/shopping-list/?list=${LIST_ID}`);
    assert.match(body.message, /1 \/ 5 נקנו/);
  });
});

test("an error from a tool becomes a 400 with its message intact", async () => {
  const rtdb = installFakeRtdb({});
  try {
    const response = await call("GET", "/api/list");
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; message: string };
    assert.match(body.message, /No list exists/);
    // The "Error:" prefix the MCP layer adds is stripped, since HTTP already carries the status.
    assert.doesNotMatch(body.message, /^Error:/);
  } finally {
    rtdb.restore();
  }
});

test("a malformed body is reported as such rather than as a server fault", async () => {
  await withDb(async () => {
    const response = await call("POST", "/api/items", "{not json");
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "invalid_body");
  });
});

test("an unknown /api route explains where to look", async () => {
  await withDb(async () => {
    const response = await call("GET", "/api/nonsense");
    assert.equal(response.status, 404);
    const body = (await response.json()) as { message: string };
    assert.match(body.message, /openapi\.json/);
  });
});

test("the OpenAPI document describes the routes that exist", async () => {
  await withDb(async () => {
    const response = await call("GET", "/api/openapi.json");
    assert.equal(response.status, 200);
    const doc = (await response.json()) as {
      openapi: string;
      servers: { url: string }[];
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    assert.match(doc.openapi, /^3\.1/);
    assert.deepEqual(Object.keys(doc.paths).sort(), [
      "/api/items",
      "/api/items/check",
      "/api/items/remove",
      "/api/link",
      "/api/list",
      "/api/reset"
    ]);
    // Every documented operation must actually be routed, or an assistant will call a 404.
    const documented = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map(method => `${method.toUpperCase()} ${path}`)
    );
    for (const route of documented) {
      const [method, path] = route.split(" ") as [string, string];
      const probe = await call(method, path, method === "POST" ? {} : undefined);
      assert.notEqual(probe.status, 404, `${route} is documented but not routed`);
    }
    assert.equal(doc.servers[0]?.url, "https://example.workers.dev");
  });
});

test("the OpenAPI server url keeps a secret path prefix, so it still works", async () => {
  await withDb(async () => {
    // A caller who reached us through /<token>/... must be given a server url they can use.
    const response = await worker.fetch(
      new Request(`https://example.workers.dev/${TOKEN}/api/openapi.json`),
      env
    );
    assert.equal(response.status, 200);
    const doc = (await response.json()) as { servers: { url: string }[] };
    assert.equal(doc.servers[0]?.url, `https://example.workers.dev/${TOKEN}`);
  });
});

test("REST and MCP produce the same underlying result", async () => {
  await withDb(async () => {
    // REST is a thin adapter over the tools, so the two must not drift. Add via REST, read the
    // effect back through MCP.
    await call("POST", "/api/items", { items: ["אבוקדו"], category: "פירות וירקות" });

    const mcp = await worker.fetch(
      new Request("https://example.workers.dev/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "shopping_get_list",
            arguments: { response_format: "json" }
          }
        })
      }),
      env
    );
    assert.equal(mcp.status, 200);
    const payload = (await mcp.json()) as {
      result: { structuredContent: { categories: { items: { name: string }[] }[] } };
    };
    const produce = payload.result.structuredContent.categories[0]?.items.map(i => i.name) ?? [];
    assert.ok(produce.includes("אבוקדו"), "the REST write must be visible through MCP");
  });
});
