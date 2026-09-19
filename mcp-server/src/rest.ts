/**
 * Plain HTTP façade over the same tools.
 *
 * This exists because most things that can talk to an API cannot speak MCP: a ChatGPT custom
 * action, an iOS Shortcut driven by Siri, a cron job, curl.
 *
 * It is a thin adapter rather than a second implementation. Every route calls the corresponding
 * MCP tool in-process over an in-memory transport, so matching, confirmation guards,
 * compare-and-swap writes and error text are the tools' own and the two interfaces cannot drift
 * apart.
 *
 * Routes and their OpenAPI description come from one table, so a documented operation cannot
 * exist without being routed, and the schema cannot describe a parameter the route ignores.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

/** A JSON Schema fragment. Deliberately loose: the shapes below are hand-written. */
type Schema = Record<string, unknown>;

interface Field {
  schema: Schema;
  description: string;
}

interface Route {
  method: "GET" | "POST";
  path: string;
  /** MCP tool this delegates to. */
  tool: string;
  operationId: string;
  summary: string;
  description: string;
  /** Query parameters, for GET routes. */
  query?: Record<string, Field>;
  /** Request body properties, for POST routes. */
  body?: Record<string, Field>;
  required?: string[];
  /** Which response shape to document. */
  response: keyof typeof RESPONSES;
}

// --- Reusable field definitions -------------------------------------------------------------

const listId: Field = {
  schema: { type: "string" },
  description: "Which list. Defaults to the household's main list, so usually omit it."
};
const names: Field = {
  schema: { type: "array", items: { type: "string" } },
  description: "Product names. Matched loosely, ignoring case and Hebrew niqqud."
};
const categoryName: Field = {
  schema: { type: "string" },
  description: "Category name, matched loosely."
};
const categoryIndex: Field = {
  schema: { type: "integer", minimum: 0 },
  description: "Category position instead of a name, zero-based."
};
const confirm: Field = {
  schema: { type: "boolean" },
  description: "Must be true. Required because this destroys data; ask the user first."
};

/**
 * Items for adding.
 *
 * Declared as objects rather than "string or object". GPT Actions do not fully support `oneOf`,
 * `anyOf` or `allOf`, so a union here risks a model being unable to build a valid body at all.
 * The server still accepts bare strings, which is what an iOS Shortcut sends; the schema simply
 * describes the richer form.
 */
const newItems: Field = {
  schema: {
    type: "array",
    items: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Product name, e.g. חלב." },
        note: { type: "string", description: "Quantity or note, e.g. 2 יחידות." },
        category: { type: "string", description: "Category for this item specifically." },
        checked: { type: "boolean", description: "Whether it starts already bought." }
      }
    }
  },
  description: "Items to add. Send them all in one call rather than one call each."
};

// --- Response shapes ------------------------------------------------------------------------

const progress: Schema = {
  type: "object",
  properties: {
    done: { type: "integer" },
    total: { type: "integer" },
    percent: { type: "integer" }
  }
};

const RESPONSES = {
  mutation: {
    description: "What changed.",
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        list_name: { type: "string" },
        url: { type: "string" },
        changed: {
          type: "array",
          items: { type: "string" },
          description: "Exactly what happened, including anything skipped as ambiguous."
        },
        progress
      }
    }
  },
  list: {
    description: "The list.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        url: { type: "string" },
        progress,
        categories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              title: { type: "string" },
              hint: { type: "string", description: "Where it is in the shop." },
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
  },
  lists: {
    description: "Known lists.",
    schema: {
      type: "object",
      properties: {
        count: { type: "integer" },
        lists: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              url: { type: "string" },
              is_default: { type: "boolean" }
            }
          }
        },
        index_available: {
          type: "boolean",
          description:
            "False when the shared index of lists could not be read, meaning a list may exist without being named here."
        }
      }
    }
  },
  link: {
    description: "The link.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        name: { type: "string" },
        message: { type: "string", description: "The link with context, ready to send." }
      }
    }
  },
  deleted: {
    description: "Confirmation that the list is gone.",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" }, list_id: { type: "string" }, deleted: { type: "boolean" } }
    }
  }
} as const;

// --- The routes -----------------------------------------------------------------------------

export const ROUTES: Route[] = [
  {
    method: "GET",
    path: "/api/list",
    tool: "shopping_get_list",
    operationId: "getList",
    summary: "Read a list, its categories and what is still to buy",
    description:
      "Call this before editing when you do not know what categories or items exist. The " +
      "category index it returns can be used where a route accepts category_index.",
    query: {
      list_id: listId,
      pending_only: {
        schema: { type: "boolean" },
        description: "True to omit items already bought."
      },
      category: { schema: { type: "string" }, description: "Limit to one category." }
    },
    response: "list"
  },
  {
    method: "GET",
    path: "/api/lists",
    tool: "shopping_list_lists",
    operationId: "listLists",
    summary: "List the shopping lists that can be reached",
    description:
      "Use this to find a list's id. Lists are discovered from a shared index that both the web " +
      "page and this API keep up to date, so a list created in a browser appears here. When " +
      "index_available is false that index could not be read, and a list missing from the " +
      "response may still exist: it can be addressed by the ?list= value in its URL.",
    query: {
      include_progress: {
        schema: { type: "boolean" },
        description: "Also read each list for its name and progress. Slower."
      }
    },
    response: "lists"
  },
  {
    method: "GET",
    path: "/api/link",
    tool: "shopping_share_list",
    operationId: "getLink",
    summary: "Get a shareable link to a list",
    description:
      "Returns the link plus a message ready to send in a chat. Anyone who opens the link can " +
      "edit the list.",
    query: {
      list_id: listId,
      include_items: {
        schema: { type: "boolean" },
        description: "Append what is still to buy."
      },
      include_progress: { schema: { type: "boolean" }, description: "Append a progress line." }
    },
    response: "link"
  },
  {
    method: "POST",
    path: "/api/items",
    tool: "shopping_add_items",
    operationId: "addItems",
    summary: "Add items to a list",
    description:
      "An item already present is not duplicated. A named category that does not exist is " +
      "created unless create_category is false.",
    body: {
      list_id: listId,
      items: newItems,
      category: {
        schema: { type: "string" },
        description: "Category for items that do not name their own."
      },
      create_category: {
        schema: { type: "boolean" },
        description: "Create a named category that does not exist yet. Defaults to true."
      },
      on_duplicate: {
        schema: { type: "string", enum: ["skip", "update_note"] },
        description: "What to do when the item is already there. Defaults to skip."
      }
    },
    required: ["items"],
    response: "mutation"
  },
  {
    method: "POST",
    path: "/api/items/check",
    tool: "shopping_set_checked",
    operationId: "checkItems",
    summary: "Mark items bought, or clear the mark",
    description:
      "The common action while shopping. Pass checked false to clear a mark, or all true to " +
      "apply to everything in scope.",
    body: {
      list_id: listId,
      items: names,
      checked: {
        schema: { type: "boolean" },
        description: "True marks bought, false clears. Defaults to true."
      },
      category: { schema: { type: "string" }, description: "Restrict the search to one category." },
      all: {
        schema: { type: "boolean" },
        description: "Apply to every item in scope, ignoring items."
      }
    },
    response: "mutation"
  },
  {
    method: "POST",
    path: "/api/items/update",
    tool: "shopping_update_item",
    operationId: "updateItem",
    summary: "Change one item's name, note or bought mark",
    description: "For editing a single row. To mark several items bought, use checkItems instead.",
    body: {
      list_id: listId,
      item: { schema: { type: "string" }, description: "Current product name of the row to edit." },
      category: { schema: { type: "string" }, description: "Restrict the search to one category." },
      new_name: { schema: { type: "string" }, description: "New product name." },
      new_note: {
        schema: { type: "string" },
        description: "New quantity or note. An empty string clears it."
      },
      checked: { schema: { type: "boolean" }, description: "New bought state." }
    },
    required: ["item"],
    response: "mutation"
  },
  {
    method: "POST",
    path: "/api/items/remove",
    tool: "shopping_remove_items",
    operationId: "removeItems",
    summary: "Delete items from a list",
    description:
      "Deletes rows outright. For something that was bought, prefer checkItems so it stays on " +
      "the list for next time. Confirm with the user first.",
    body: { list_id: listId, items: names, category: { schema: { type: "string" }, description: "Restrict to one category." } },
    required: ["items"],
    response: "mutation"
  },
  {
    method: "POST",
    path: "/api/items/move",
    tool: "shopping_move_item",
    operationId: "moveItem",
    summary: "Move an item to another category, or reorder it",
    description: "Supply to_category to move between categories, or to_index alone to reorder.",
    body: {
      list_id: listId,
      item: { schema: { type: "string" }, description: "Product name of the row to move." },
      from_category: {
        schema: { type: "string" },
        description: "Restrict the search for the row to this category."
      },
      to_category: { schema: { type: "string" }, description: "Destination category name." },
      to_category_index: categoryIndex,
      to_index: {
        schema: { type: "integer", minimum: 0 },
        description: "Position within the destination category."
      }
    },
    required: ["item"],
    response: "mutation"
  },
  {
    method: "POST",
    path: "/api/reset",
    tool: "shopping_clear_checked",
    operationId: "resetList",
    summary: "Tidy up after a shop",
    description:
      "mode untick clears every bought mark but keeps the rows, for a list reused each week. " +
      "mode remove deletes the bought rows and needs confirm true.",
    body: {
      list_id: listId,
      mode: {
        schema: { type: "string", enum: ["untick", "remove"] },
        description: "Defaults to untick, which keeps the rows."
      },
      category: { schema: { type: "string" }, description: "Restrict to one category." },
      confirm: { schema: { type: "boolean" }, description: "Required when mode is remove." }
    },
    response: "mutation"
  },
  {
    method: "POST",
    path: "/api/categories",
    tool: "shopping_add_category",
    operationId: "addCategory",
    summary: "Add a category",
    description:
      "Categories are the supermarket-aisle groupings shown as headings. Their order is the " +
      "route through the shop.",
    body: {
      list_id: listId,
      title: { schema: { type: "string" }, description: "Category name, e.g. פירות וירקות." },
      hint: {
        schema: { type: "string" },
        description: "Where it is in the shop, shown under the title."
      },
      items: newItems,
      position: {
        schema: { type: "integer", minimum: 0 },
        description: "Where to insert it. Appended when omitted."
      }
    },
    required: ["title"],
    response: "mutation"
  },
  {
    method: "POST",
    path: "/api/categories/update",
    tool: "shopping_update_category",
    operationId: "updateCategory",
    summary: "Rename a category or change its aisle hint",
    description: "Items inside it are untouched. Supply new_title, new_hint, or both.",
    body: {
      list_id: listId,
      category: categoryName,
      category_index: categoryIndex,
      new_title: { schema: { type: "string" }, description: "New category name." },
      new_hint: {
        schema: { type: "string" },
        description: "New aisle hint. An empty string clears it."
      }
    },
    response: "mutation"
  },
  {
    method: "POST",
    path: "/api/categories/remove",
    tool: "shopping_remove_category",
    operationId: "removeCategory",
    summary: "Remove a category and everything in it",
    description:
      "Discards the items inside, so confirm true is required when it still holds any. Ask the " +
      "user first.",
    body: { list_id: listId, category: categoryName, category_index: categoryIndex, confirm },
    response: "mutation"
  },
  {
    method: "POST",
    path: "/api/categories/move",
    tool: "shopping_move_category",
    operationId: "moveCategory",
    summary: "Reorder a category",
    description: "Use this to make the list order match the walk through the shop.",
    body: {
      list_id: listId,
      category: categoryName,
      category_index: categoryIndex,
      to_index: {
        schema: { type: "integer", minimum: 0 },
        description: "Destination position, zero-based."
      }
    },
    required: ["to_index"],
    response: "mutation"
  },
  {
    method: "POST",
    path: "/api/lists",
    tool: "shopping_create_list",
    operationId: "createList",
    summary: "Create a new shopping list",
    description:
      "Returns the new list including the link that opens it. Use this for a separate occasion, " +
      "such as a holiday shop, rather than for adding to the existing list.",
    body: {
      name: { schema: { type: "string" }, description: "Name for the new list, e.g. קניות לשבת." },
      categories: {
        schema: {
          type: "array",
          items: {
            type: "object",
            required: ["title"],
            properties: {
              title: { type: "string", description: "Category name." },
              hint: { type: "string", description: "Where it is in the shop." }
            }
          }
        },
        description:
          "Categories to start with. Omit for a small Hebrew starter set, or send an empty array for none."
      },
      list_id: {
        schema: { type: "string" },
        description: "Use this exact id instead of generating one. Usually omit."
      }
    },
    response: "list"
  },
  {
    method: "POST",
    path: "/api/list/rename",
    tool: "shopping_rename_list",
    operationId: "renameList",
    summary: "Rename a list",
    description: "Changes the name shown on the page. Not for renaming a category.",
    body: { list_id: listId, name: { schema: { type: "string" }, description: "New name." } },
    required: ["name"],
    response: "mutation"
  },
  {
    method: "POST",
    path: "/api/list/delete",
    tool: "shopping_delete_list",
    operationId: "deleteList",
    summary: "Permanently delete a list",
    description:
      "Deletes the list for everyone holding its link. It cannot be undone. Always confirm with " +
      "the user, and never call it speculatively. list_id is required: there is deliberately no " +
      "default, so the main list cannot be deleted by omission.",
    body: {
      list_id: {
        schema: { type: "string" },
        description: "Id of the list to delete. Required, with no default."
      },
      confirm
    },
    required: ["list_id", "confirm"],
    response: "deleted"
  }
];

// --- Dispatch -------------------------------------------------------------------------------

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
 * Accept `items` as strings as well as objects.
 *
 * The schema describes objects, because GPT Actions handle a union badly, but an iOS Shortcut
 * can only produce an array of text, so both are accepted here.
 */
function normalizeItems(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(entry => (typeof entry === "string" ? { name: entry } : entry));
}

/** Coerce a query string value according to its declared schema. */
function coerce(raw: string, schema: Schema): unknown {
  if (schema.type === "boolean") return raw !== "false" && raw !== "0" && raw !== "";
  if (schema.type === "integer" || schema.type === "number") {
    const value = Number(raw);
    return Number.isFinite(value) ? value : raw;
  }
  return raw;
}

/** Handle a request under `/api/`. Returns null when the path is not a REST route. */
export async function handleRest(request: Request, path: string, url: URL): Promise<Response | null> {
  if (!path.startsWith("/api/")) return null;
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/api/openapi.json") {
    return json(200, openApiDocument(url));
  }

  const route = ROUTES.find(entry => entry.path === path && entry.method === method);
  if (!route) {
    const alternatives = ROUTES.filter(entry => entry.path === path).map(entry => entry.method);
    return json(alternatives.length ? 405 : 404, {
      error: alternatives.length ? "method_not_allowed" : "not_found",
      message: alternatives.length
        ? `${path} accepts ${alternatives.join(", ")}, not ${method}.`
        : `No route ${method} ${path}. See GET /api/openapi.json for the available operations.`
    });
  }

  try {
    const args: Record<string, unknown> = { response_format: "json" };
    if (route.method === "GET") {
      for (const [name, field] of Object.entries(route.query ?? {})) {
        const raw = url.searchParams.get(name);
        if (raw !== null) args[name] = coerce(raw, field.schema);
      }
    } else {
      const body = await readBody(request);
      for (const [name, value] of Object.entries(body)) {
        if (value !== undefined && value !== null) args[name] = value;
      }
      if (args.items !== undefined && route.tool !== "shopping_set_checked" && route.tool !== "shopping_remove_items") {
        args.items = normalizeItems(args.items);
      }
    }
    return await callTool(route.tool, args);
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

/**
 * OpenAPI 3.1 description, generated from the route table.
 *
 * No `oneOf`, `anyOf` or `allOf` anywhere: GPT Actions do not fully support them, and a union in
 * a request body can leave a model unable to construct a valid call at all.
 */
export function openApiDocument(url: URL): Record<string, unknown> {
  // Preserve a secret path prefix if the caller reached us through one, so the server url given
  // back is one that actually works for them.
  const prefix = url.pathname.replace(/\/api\/openapi\.json$/, "");
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      description: route.description,
      responses: {
        "200": {
          description: RESPONSES[route.response].description,
          content: { "application/json": { schema: RESPONSES[route.response].schema } }
        }
      }
    };

    if (route.method === "GET" && route.query) {
      operation.parameters = Object.entries(route.query).map(([name, field]) => ({
        name,
        in: "query",
        required: false,
        schema: field.schema,
        description: field.description
      }));
    }
    if (route.method === "POST" && route.body) {
      operation.requestBody = {
        required: Boolean(route.required?.length),
        content: {
          "application/json": {
            schema: {
              type: "object",
              ...(route.required?.length ? { required: route.required } : {}),
              properties: Object.fromEntries(
                Object.entries(route.body).map(([name, field]) => [
                  name,
                  { ...field.schema, description: field.description }
                ])
              )
            }
          }
        }
      };
    }

    paths[route.path] = { ...(paths[route.path] ?? {}), [route.method.toLowerCase()]: operation };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Shopping list",
      version: "1.0.0",
      description:
        "Read and edit shared household shopping lists. Items and categories are in Hebrew. " +
        "Put quantities in an item's note rather than in its name. Names are matched loosely, so " +
        "a partial name usually works; when one matches several rows the response says so and " +
        "skips it rather than guessing, so relay that and ask which was meant. Every write " +
        "returns a changed array naming exactly what happened, including anything skipped."
    },
    servers: [{ url: `${url.origin}${prefix}` }],
    paths
  };
}
