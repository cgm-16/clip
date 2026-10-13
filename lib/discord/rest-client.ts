/**
 * Bot-authenticated access to the Discord REST API.
 *
 * `fetch` is injected rather than referenced globally so tests can drive the
 * error and rate-limit paths without a network, and so a route handler and a
 * script can share one client without either reaching for a module mock.
 */

import { setTimeout as defaultSleep } from 'node:timers/promises';
import { logClipEvent } from '@/lib/logging/safe-log';

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

/**
 * Only Discord's own "unknown message/channel" codes confirm a copy is gone.
 * Codes alone: a bare 404 or 403 can come from an edge proxy or a permission
 * gap, and treating either as "gone" would repost a copy that still exists.
 */
export function isUnknownTarget(error: unknown): boolean {
  return (
    error instanceof DiscordApiError &&
    (error.code === DISCORD_ERROR.UNKNOWN_MESSAGE || error.code === DISCORD_ERROR.UNKNOWN_CHANNEL)
  );
}

/**
 * What a failed Discord call can safely say about itself: the class of
 * failure and, for an HTTP failure, the status and Discord's JSON code as
 * decimal strings. Never the message -- a `DiscordApiError`'s message names
 * the path, and any other error's message is free text (§12).
 */
export type DiscordFailureFacts = {
  failure: 'http' | 'timeout' | 'network';
  httpStatus?: string;
  discordCode?: string;
};

/**
 * Classes a failed Discord call by its type and name alone. `TimeoutError` is
 * what `AbortSignal.timeout` raises; `AbortError` is the same abort reported
 * by a runtime that does not distinguish the two.
 */
export function describeDiscordFailure(error: unknown): DiscordFailureFacts {
  if (error instanceof DiscordApiError) {
    return error.code === null
      ? { failure: 'http', httpStatus: String(error.status) }
      : { failure: 'http', httpStatus: String(error.status), discordCode: String(error.code) };
  }
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { failure: 'timeout' };
  }
  return { failure: 'network' };
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
const DISCORD_REQUEST_TIMEOUT_MS = 10_000;

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

function isGlobalRateLimit(response: Response, body: unknown): boolean {
  if (response.headers.get('X-RateLimit-Global') === 'true') {
    return true;
  }
  return typeof body === 'object' && body !== null && (body as { global?: unknown }).global === true;
}

/**
 * The request path with its variable parts replaced, so retries group by
 * route rather than by the ids in them: every all-digit segment becomes
 * `{id}`, the interaction token in a webhook path becomes `{token}`, and the
 * query string is dropped. Only lowercase route words (`channels`, `@me`)
 * are kept; any other segment becomes `{value}`. The token is a credential
 * and a query or an unknown segment can carry anything, so none of them may
 * reach a log line -- the rule fails closed for a path added later.
 */
export function discordRouteTemplate(path: string): string {
  const segments = path.split('?')[0].split('/');
  return segments
    .map((segment, index) => {
      if (/^\d+$/.test(segment)) {
        return '{id}';
      }
      if (index >= 2 && segments[index - 2] === 'webhooks') {
        return '{token}';
      }
      return segment === '' || /^@?[a-z-]+$/.test(segment) ? segment : '{value}';
    })
    .join('/');
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
      signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
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
          const delayMs = retryDelayMs(payload);
          // Only the retried 429s: the final one is thrown, and reporting it
          // belongs to the caller that decides what the failure means.
          logClipEvent({
            event: 'discord.rate_limited',
            method,
            route: discordRouteTemplate(path),
            retryAfterMs: String(delayMs),
            attempt: String(MAX_ATTEMPTS - remaining + 1),
            rateLimitScope: response.headers.get('X-RateLimit-Scope') ?? undefined,
            rateLimitBucket: response.headers.get('X-RateLimit-Bucket') ?? undefined,
            rateLimitGlobal: String(isGlobalRateLimit(response, payload)),
          });
          await sleep(delayMs);
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
