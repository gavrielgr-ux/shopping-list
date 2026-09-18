import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { progressOf } from "../normalize.js";
import { urlForList } from "../store.js";
import type { ListPayload } from "../types.js";

export interface ToolReply {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** The SDK's result type is an open record; this keeps handlers assignable to it. */
  [key: string]: unknown;
}

/**
 * Turn any thrown value into an error reply.
 *
 * Failures come back inside a successful tool result rather than as a protocol error, so the
 * model can read the message and correct its next call instead of the whole request aborting.
 */
export function toErrorReply(error: unknown): ToolReply {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }]
  };
}

/** Wrap a handler so every tool reports failures the same way. */
export function guard<A>(handler: (args: A) => Promise<ToolReply>): (args: A) => Promise<ToolReply> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      return toErrorReply(error);
    }
  };
}

/** Build the structured body shared by all mutating tools. */
export function mutationResult(
  listId: string,
  payload: ListPayload,
  changed: string[],
  retries: number
): Record<string, unknown> {
  return {
    ok: true as const,
    list_id: listId,
    list_name: payload.name,
    url: urlForList(listId),
    changed,
    progress: progressOf(payload),
    retries
  };
}

/** Narrow alias so tool modules do not each import the SDK type. */
export type Server = McpServer;
