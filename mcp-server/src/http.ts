import { REQUEST_TIMEOUT_MS } from "./constants.js";

/** An HTTP failure carrying the status and body so callers can react to specific codes. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message?: string
  ) {
    super(message ?? `HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "HttpError";
  }
}

/** A network-level failure: DNS, TLS, connection reset, or timeout. */
export class NetworkError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Treat these statuses as success and hand the response back to the caller. */
  allowStatuses?: number[];
}

/**
 * Perform one HTTP request with a hard timeout.
 *
 * `fetch` has no default timeout, so without the abort signal a stalled connection would hang
 * the MCP client indefinitely with no way to recover.
 */
export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new NetworkError(
        `Request to ${new URL(url).host} timed out after ${REQUEST_TIMEOUT_MS}ms. Check network access to the Firebase Realtime Database.`,
        error
      );
    }
    throw new NetworkError(
      `Could not reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok && !(options.allowStatuses ?? []).includes(response.status)) {
    throw new HttpError(response.status, await response.text().catch(() => ""));
  }
  return response;
}

/** Perform a request and parse the JSON body. */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(url, options);
  const text = await response.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${new URL(url).host} but received: ${text.slice(0, 200)}`);
  }
}
