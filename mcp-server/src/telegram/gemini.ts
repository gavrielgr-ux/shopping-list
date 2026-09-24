/**
 * Gemini through its OpenAI-compatible endpoint, with plain `fetch` and no SDK.
 *
 * Two behaviours come from incidents in the book-recommender bot:
 *
 *  - The newest Flash model often answers 503 "high demand" on the free tier, so models are
 *    tried in order and a busy one hands over to the next.
 *  - Once a model has answered, the rest of the turn stays on it. Gemini 3 attaches thought
 *    signatures to tool calls, and a signature is only valid for the model that made it.
 *
 * The key travels in the Authorization header, never in a URL.
 */

type FetchLike = typeof fetch;

export const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

/** One model call may take this long before the next model is tried. */
export const MODEL_TIMEOUT_MS = 20_000;

/** Statuses that mean "busy or rate limited", worth trying another model for. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface ToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments?: string };
  /** Carries `google.thought_signature`, which must go back exactly as received. */
  extra_content?: unknown;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | { type?: string; text?: string }[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionOptions {
  /** Stay on this model: set once a model has answered during the turn. */
  model?: string;
  /** Epoch milliseconds by which the whole turn must be finished. */
  deadline: number;
}

export interface ModelClient {
  readonly models: string[];
  complete(
    messages: ChatMessage[],
    tools: OpenAiTool[],
    options: CompletionOptions
  ): Promise<{ model: string; message: ChatMessage }>;
}

/** Every model was busy, rate limited or too slow. The user gets a "try again" message. */
export class ModelsBusyError extends Error {
  constructor(message = "every model is busy") {
    super(message);
    this.name = "ModelsBusyError";
  }
}

/** A failure that another model would not fix, such as a rejected request. */
export class ModelError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export function geminiClient(
  apiKey: string,
  models: string[],
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now
): ModelClient {
  return {
    models,
    async complete(messages, tools, { model: sticky, deadline }) {
      const candidates = sticky ? [sticky] : models;
      for (const model of candidates) {
        const remaining = deadline - now();
        if (remaining < 1_000) throw new ModelsBusyError("out of time for this turn");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(MODEL_TIMEOUT_MS, remaining));
        let response: Response;
        try {
          response = await fetchImpl(GEMINI_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              messages,
              ...(tools.length ? { tools, tool_choice: "auto" } : {}),
              reasoning_effort: "low"
            }),
            signal: controller.signal
          });
        } catch (error) {
          const reason = controller.signal.aborted
            ? "timed out"
            : error instanceof Error
              ? error.message
              : String(error);
          console.warn(`telegram bot: ${model} failed (${reason}), trying the next model`);
          continue;
        } finally {
          clearTimeout(timer);
        }

        if (RETRYABLE.has(response.status)) {
          console.warn(`telegram bot: ${model} answered ${response.status}, trying the next model`);
          continue;
        }
        const body = await response.text();
        if (!response.ok) {
          throw new ModelError(
            response.status,
            `${model} rejected the request (${response.status}): ${body.slice(0, 500)}`
          );
        }
        let message: ChatMessage | undefined;
        try {
          message = (JSON.parse(body) as { choices?: { message?: ChatMessage }[] }).choices?.[0]
            ?.message;
        } catch {
          // Reported below together with an empty answer.
        }
        if (!message) throw new ModelError(response.status, `${model} returned no message`);
        return { model, message };
      }
      throw new ModelsBusyError();
    }
  };
}
