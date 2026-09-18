/**
 * Plain HTTP façade over the same tools.
 *
 * This exists because most things that can talk to an API cannot speak MCP: a ChatGPT custom
 * action, an iOS Shortcut driven by Siri, a cron job, curl. Those need ordinary REST with an
 * OpenAPI description.
 *
 * It is deliberately a thin adapter rather than a second implementation. Each route calls the
 * corresponding MCP tool in-process over an in-memory transport, so the two interfaces cannot
 * drift apart: matching, confirmation guards, compare-and-swap writes and error text are the
 * tools' own. The cost is one in-memory round trip per request, which is nothing next to the
 * database call it wraps.
 *
 * Only the operations worth having on a phone are exposed. MCP remains the full interface; a
 * sprawling OpenAPI document makes an assistant worse at choosing, not better.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

interface ToolCallResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });

/** Run one tool and translate its result into an HTTP response. */
async function callTool(name: string, args: Record<string, unknown>): Promise<Response> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "shopping-list-rest", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const result = (await client.callTool({ name, arguments: args })) as ToolCallResult;
    const text = (result.content ?? [])
      .filter(part => part.type === "text")
      .map(part => part.text ?? "")
      .join("\n");

    if (result.isError) {
      // The tools already produce actionable messages; a 400 keeps them readable to a caller
      // that can correct its next request.
      return json(400, { error: "request_failed", message: text.replace(/^Error:\s*/, "") });
    }
    return json(200, result.structuredContent ?? { ok: true, message: text });
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

/** Parse a JSON body, tolerating an empty one. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new SyntaxError(error instanceof Error ? error.message : "invalid JSON");
  }
}

/**
 * Accept `items` as either strings or objects.
 *
 * `["חלב", "ביצים"]` is what a Shortcut or a language model naturally produces; the objects are
 * there for when a note or a per-item category is needed.
 */
function normalizeItems(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(entry => (typeof entry === "string" ? { name: entry } : entry));
}

/** Drop keys the caller left out, so tool defaults apply instead of explicit undefined. */
const defined = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

export interface RestRoute {
  method: string;
  path: string;
}

/**
 * Handle a request under `/api/`.
 *
 * Returns null when the path is not a REST route, so the caller can fall through.
 */
export async function handleRest(request: Request, path: string, url: URL): Promise<Response | null> {
  const route = `${request.method.toUpperCase()} ${path}`;
  const query = url.searchParams;
  const boolOf = (name: string): boolean | undefined => {
    const raw = query.get(name);
    if (raw === null) return undefined;
    return raw !== "false" && raw !== "0";
  };

  try {
    switch (route) {
      case "GET /api/openapi.json":
        return json(200, openApiDocument(url));

      case "GET /api/list":
        return await callTool(
          "shopping_get_list",
          defined({
            list_id: query.get("list_id") ?? undefined,
            pending_only: boolOf("pending_only"),
            category: query.get("category") ?? undefined,
            response_format: "json"
          })
        );

      case "GET /api/link":
        return await callTool(
          "shopping_share_list",
          defined({
            list_id: query.get("list_id") ?? undefined,
            include_items: boolOf("include_items"),
            include_progress: boolOf("include_progress"),
            response_format: "json"
          })
        );

      case "POST /api/items": {
        const body = await readBody(request);
        return await callTool(
          "shopping_add_items",
          defined({ ...body, items: normalizeItems(body.items), response_format: "json" })
        );
      }

      case "POST /api/items/check": {
        const body = await readBody(request);
        return await callTool("shopping_set_checked", defined({ ...body, response_format: "json" }));
      }

      case "POST /api/items/remove": {
        const body = await readBody(request);
        return await callTool("shopping_remove_items", defined({ ...body, response_format: "json" }));
      }

      case "POST /api/reset": {
        const body = await readBody(request);
        return await callTool("shopping_clear_checked", defined({ ...body, response_format: "json" }));
      }

      default:
        if (!path.startsWith("/api/")) return null;
        return json(404, {
          error: "not_found",
          message: `No route ${route}. See GET /api/openapi.json for the available operations.`
        });
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json(400, { error: "invalid_body", message: `Could not read the JSON body: ${error.message}` });
    }
    return json(500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

/** OpenAPI 3.1 description, for a ChatGPT custom action or any other client that wants one. */
export function openApiDocument(url: URL): Record<string, unknown> {
  // Preserve a secret path prefix if the caller reached us through one, so the generated server
  // URL is one that actually works for them.
  const prefix = url.pathname.replace(/\/api\/openapi\.json$/, "");
  const server = `${url.origin}${prefix}`;

  const listId = {
    name: "list_id",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "Which list. Defaults to the household's main list, so usually omit it."
  };
  const itemsProperty = {
    type: "array",
    description:
      "Product names. Plain strings are fine; use objects to add a note or a per-item category.",
    items: {
      oneOf: [
        { type: "string" },
        {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", description: "Product name, e.g. חלב." },
            note: { type: "string", description: "Quantity or note, e.g. 2 יחידות." },
            category: { type: "string", description: "Category for this item specifically." },
            checked: { type: "boolean", description: "Whether it starts ticked off." }
          }
        }
      ]
    }
  };
  const mutation = {
    description: "What changed.",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            list_name: { type: "string" },
            changed: { type: "array", items: { type: "string" } },
            progress: {
              type: "object",
              properties: {
                done: { type: "integer" },
                total: { type: "integer" },
                percent: { type: "integer" }
              }
            }
          }
        }
      }
    }
  };
  const names = {
    type: "array",
    items: { type: "string" },
    description: "Product names. Matched loosely, ignoring case and Hebrew niqqud."
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Shopping list",
      version: "1.0.0",
      description:
        "Read and edit a shared household shopping list. Items and categories are in Hebrew. " +
        "Put quantities in an item's note rather than in its name. Names are matched loosely, " +
        "so a partial name usually works; when one matches several rows the response says so " +
        "and skips it rather than guessing."
    },
    servers: [{ url: server }],
    paths: {
      "/api/list": {
        get: {
          operationId: "getList",
          summary: "Read the list, its categories and what is still to buy",
          parameters: [
            listId,
            {
              name: "pending_only",
              in: "query",
              required: false,
              schema: { type: "boolean" },
              description: "True to omit items already bought."
            },
            {
              name: "category",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Limit to one category."
            }
          ],
          responses: {
            "200": {
              description: "The list.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      url: { type: "string" },
                      progress: {
                        type: "object",
                        properties: {
                          done: { type: "integer" },
                          total: { type: "integer" },
                          percent: { type: "integer" }
                        }
                      },
                      categories: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            title: { type: "string" },
                            hint: { type: "string" },
                            items: {
                              type: "array",
                              items: {
                                type: "object",
                                properties: {
                                  name: { type: "string" },
                                  note: { type: "string" },
                                  checked: { type: "boolean" }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/items": {
        post: {
          operationId: "addItems",
          summary: "Add items to the list",
          description:
            "Adds several items in one call. An item already present is not duplicated. A named " +
            "category that does not exist is created unless create_category is false.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items"],
                  properties: {
                    list_id: { type: "string" },
                    items: itemsProperty,
                    category: {
                      type: "string",
                      description: "Category for items that do not name their own."
                    },
                    create_category: { type: "boolean" },
                    on_duplicate: { type: "string", enum: ["skip", "update_note"] }
                  }
                }
              }
            }
          },
          responses: { "200": mutation }
        }
      },
      "/api/items/check": {
        post: {
          operationId: "checkItems",
          summary: "Tick items off, or un-tick them",
          description:
            "Use this when something has been bought. Pass checked=false to clear a tick, or " +
            "all=true to apply to everything, which is how you reset the list for next time.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    list_id: { type: "string" },
                    items: names,
                    checked: { type: "boolean", description: "True ticks off, false clears." },
                    category: { type: "string" },
                    all: { type: "boolean" }
                  }
                }
              }
            }
          },
          responses: { "200": mutation }
        }
      },
      "/api/items/remove": {
        post: {
          operationId: "removeItems",
          summary: "Delete items from the list",
          description:
            "Deletes rows outright. For something that was bought, prefer checkItems so it stays " +
            "on the list for next time.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items"],
                  properties: {
                    list_id: { type: "string" },
                    items: names,
                    category: { type: "string" }
                  }
                }
              }
            }
          },
          responses: { "200": mutation }
        }
      },
      "/api/reset": {
        post: {
          operationId: "resetList",
          summary: "Tidy up after a shop",
          description:
            "mode=untick clears every tick but keeps the rows, for a list reused each week. " +
            "mode=remove deletes the bought rows and requires confirm=true.",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    list_id: { type: "string" },
                    mode: { type: "string", enum: ["untick", "remove"] },
                    category: { type: "string" },
                    confirm: { type: "boolean" }
                  }
                }
              }
            }
          },
          responses: { "200": mutation }
        }
      },
      "/api/link": {
        get: {
          operationId: "getLink",
          summary: "Get a shareable link to the list",
          description: "Returns the link plus a message ready to send in a chat.",
          parameters: [
            listId,
            {
              name: "include_items",
              in: "query",
              required: false,
              schema: { type: "boolean" },
              description: "Append what is still to buy."
            },
            {
              name: "include_progress",
              in: "query",
              required: false,
              schema: { type: "boolean" }
            }
          ],
          responses: {
            "200": {
              description: "The link.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      url: { type: "string" },
                      name: { type: "string" },
                      message: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}
