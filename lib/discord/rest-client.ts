/**
 * Bot-authenticated access to the Discord REST API.
 *
 * `fetch` is injected rather than referenced globally so tests can drive the
 * error and rate-limit paths without a network, and so a route handler and a
 * script can share one client without either reaching for a module mock.
 */

const API_BASE = 'https://discord.com/api/v10';

/**
 * Discord JSON error codes this codebase branches on. Discord returns these in
 * the response body and they are far more specific than the HTTP status: a 400
 * alone cannot distinguish "you attached content to a forward" from "you may
 * not read the source", and the two have different product outcomes (§6.3, §15).
 */
export const DISCORD_ERROR = {
  UNKNOWN_MESSAGE: 10008,
  UNKNOWN_CHANNEL: 10003,
  MISSING_ACCESS: 50001,
  CANNOT_SEND_DM: 50007,
  MISSING_PERMISSIONS: 50013,
  FORWARD_WITH_ADDITIONAL_CONTENT: 160011,
  CANNOT_FORWARD_UNREADABLE: 160014,
} as const;

/**
 * A Discord API call that did not succeed.
 *
 * `code` is the JSON error code where Discord supplied one, and null otherwise.
 * The response body is deliberately *not* retained: an error body echoes the
 * request, and a request that posts an archive entry echoes message content
 * (§12, §17 case 18). Callers get the status and the code, never the payload.
 */
export class DiscordApiError extends Error {
  readonly status: number;
  readonly code: number | null;

  constructor(message: string, options: { status: number; code: number | null }) {
    super(message);
    this.name = 'DiscordApiError';
    this.status = options.status;
    this.code = options.code;
  }

  /** 5xx and exhausted rate limits are worth another attempt; 4xx is not. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

export type DiscordRestClient = {
  /** Returns the parsed JSON body, or null for a 204. Throws `DiscordApiError`. */
  request(method: string, path: string, body?: unknown): Promise<unknown>;
};

export type DiscordRestClientOptions = {
  botToken: string;
  fetchImpl: typeof fetch;
  /** Injected so a rate-limit test does not have to wait in real time. */
  sleep?: (ms: number) => Promise<void>;
};

// Three attempts, not more. A 429 is Discord asking for a pause, but an
// interaction has already been deferred by the time the archive is built and
// the user is waiting -- retrying indefinitely turns a slow response into one
// that never arrives.
const MAX_ATTEMPTS = 3;

// Discord reports `retry_after` in seconds, as a float. Cap it: a global limit
// can report a value far longer than any interaction can wait for, and honouring
// it exactly would hold the request open well past the point of usefulness.
const MAX_RETRY_DELAY_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the JSON body, tolerating a response that has none.
 *
 * Discord answers 204 with an empty body and can answer an error with HTML from
 * an edge proxy rather than JSON, so a bare `response.json()` would throw and
 * mask the status the caller actually needs.
 */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorCodeOf(body: unknown): number | null {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const code = (body as { code: unknown }).code;
    if (typeof code === 'number') {
      return code;
    }
  }
  return null;
}

function retryDelayMs(body: unknown): number {
  if (typeof body === 'object' && body !== null && 'retry_after' in body) {
    const retryAfter = (body as { retry_after: unknown }).retry_after;
    if (typeof retryAfter === 'number' && retryAfter >= 0) {
      return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
    }
  }
  return 1000;
}

export function createDiscordRestClient(options: DiscordRestClientOptions): DiscordRestClient {
  const { botToken, fetchImpl } = options;
  const sleep = options.sleep ?? defaultSleep;

  async function attempt(method: string, path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bot ${botToken}` };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return fetchImpl(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  return {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      for (let remaining = MAX_ATTEMPTS; remaining > 0; remaining -= 1) {
        const response = await attempt(method, path, body);
        if (response.ok) {
          return readJson(response);
        }

        const payload = await readJson(response);

        // Only a rate limit is retried in place. A 5xx is surfaced with
        // `retryable` set and re-decided by the caller, which knows whether the
        // control-plane state it already wrote makes a second attempt safe.
        if (response.status === 429 && remaining > 1) {
          await sleep(retryDelayMs(payload));
          continue;
        }

        throw new DiscordApiError(`Discord ${method} ${path} failed with ${response.status}`, {
          status: response.status,
          code: errorCodeOf(payload),
        });
      }

      // Unreachable: the loop either returns, throws, or continues, and the
      // final iteration cannot continue because `remaining > 1` is false.
      throw new Error('unreachable: rate-limit retry loop exited without a result');
    },
  };
}
