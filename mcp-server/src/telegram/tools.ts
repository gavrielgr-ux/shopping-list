/**
 * The bridge from the bot to the 16 MCP tools, called in-process like `rest.ts` does.
 *
 * One server and client pair is kept per isolate. Building them costs a few milliseconds of CPU,
 * which matters on the free plan's budget, and the tools hold no per-conversation state: every
 * call is an independent read or compare-and-swap against the database.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { BUILT_CATALOG } from "./catalog-data.js";
import { toDeclarations, type ToolDeclaration } from "./catalog.js";

export interface ToolResult {
  text: string;
  isError: boolean;
  structured?: Record<string, unknown>;
}

/** What the agent needs from the tools. Tests substitute their own. */
export interface ToolRunner {
  declarations(): Promise<ToolDeclaration[]>;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

let clientPromise: Promise<Client> | null = null;
let declarationsPromise: Promise<ToolDeclaration[]> | null = null;

function client(): Promise<Client> {
  clientPromise ??= (async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const created = new Client({ name: "shopping-list-telegram", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), created.connect(clientTransport)]);
    return created;
  })().catch(error => {
    clientPromise = null;
    throw error;
  });
  return clientPromise;
}

async function declarations(): Promise<ToolDeclaration[]> {
  if (BUILT_CATALOG) return BUILT_CATALOG;
  declarationsPromise ??= client()
    .then(connected => connected.listTools())
    .then(({ tools }) => toDeclarations(tools))
    .catch(error => {
      declarationsPromise = null;
      throw error;
    });
  return declarationsPromise;
}

interface RawResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The real tools, restricted to the ones declared to the model. */
export const mcpTools: ToolRunner = {
  declarations,
  async call(name, args) {
    // A tool left out of the declarations, such as deleting a list, stays unreachable even if a
    // model names it anyway.
    const known = await declarations();
    if (!known.some(tool => tool.name === name)) {
      return { text: `Error: there is no tool named ${name}.`, isError: true };
    }
    const result = (await (await client()).callTool({ name, arguments: args })) as RawResult;
    return {
      text: (result.content ?? [])
        .filter(part => part.type === "text")
        .map(part => part.text ?? "")
        .join("\n"),
      isError: result.isError === true,
      ...(result.structuredContent ? { structured: result.structuredContent } : {})
    };
  }
};
