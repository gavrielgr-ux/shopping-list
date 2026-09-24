/**
 * The tools as Gemini function declarations, derived from the MCP server itself.
 *
 * Never a hand-written copy: the declarations come from `listTools()`, so a tool changed in
 * `src/tools/` reaches the bot with no second edit.
 *
 * They are computed at build time, by `build-catalog.js`, rather than per request. Measured in
 * Node, one `listTools()` costs about 30 ms of CPU, because the SDK converts every zod schema to
 * JSON Schema on each call, and the Workers free plan allows about 10 ms of CPU per request. If
 * the build step did not run, `tools.ts` falls back to computing them once per isolate.
 */
import { cleanSchema } from "./schema.js";

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Tools the bot never offers the model.
 *
 * Deleting a whole list is permanent and affects everyone holding the link, and nobody needs to
 * do it from a chat. Leaving it out is safer than relying on the model to ask first.
 */
export const EXCLUDED_TOOLS = new Set(["shopping_delete_list"]);

/**
 * Parameters hidden from the model. `response_format` defaults to Markdown, which is what a
 * model reads best, and dropping it saves tokens on every call.
 */
export const HIDDEN_PARAMETERS = new Set(["response_format"]);

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export function toDeclarations(tools: ListedTool[]): ToolDeclaration[] {
  return tools
    .filter(tool => !EXCLUDED_TOOLS.has(tool.name))
    .map(tool => {
      const parameters = cleanSchema(tool.inputSchema) as Record<string, unknown>;
      const properties = { ...((parameters.properties as Record<string, unknown>) ?? {}) };
      for (const hidden of HIDDEN_PARAMETERS) delete properties[hidden];
      const required = Array.isArray(parameters.required)
        ? (parameters.required as string[]).filter(name => !HIDDEN_PARAMETERS.has(name))
        : undefined;
      return {
        name: tool.name,
        description: tool.description ?? "",
        parameters: {
          ...parameters,
          properties,
          ...(required ? { required } : {})
        }
      };
    });
}
