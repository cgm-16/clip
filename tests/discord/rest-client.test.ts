import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDiscordRestClient,
  describeDiscordFailure,
  DiscordApiError,
  discordRouteTemplate,
} from '@/lib/discord/rest-client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createDiscordRestClient', () => {
  it('starts each HTTP 429 retry with a fresh 10,000 ms abort signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      return new AbortController().signal;
    });
    const signals: (AbortSignal | null | undefined)[] = [];
    let fetchCalls = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      signals.push(init?.signal);
      return fetchCalls === 1
        ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 })
        : new Response(JSON.stringify({ id: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createDiscordRestClient({ botToken: 'bot-token', fetchImpl, sleep: async () => {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(client.request('GET', '/test')).resolves.toEqual({ id: 'ok' });
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenNthCalledWith(1, 10_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 10_000);
    expect(fetchCalls).toBe(2);
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBeDefined();
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('does not retry a timeout rejection', async () => {
    const timeoutError = new DOMException('timed out', 'TimeoutError');
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(timeoutError));
    let fetchCalls = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1;
      throw init?.signal?.reason;
    }) as unknown as typeof fetch;
    const client = createDiscordRestClient({ botToken: 'bot-token', fetchImpl });

    await expect(client.request('GET', '/test')).rejects.toBe(timeoutError);
    expect(fetchCalls).toBe(1);
  });

  it('does not retry a 502 response', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 502 });
    }) as unknown as typeof fetch;
    const client = createDiscordRestClient({ botToken: 'bot-token', fetchImpl });

    const request = client.request('GET', '/test');
    await expect(request).rejects.toBeInstanceOf(DiscordApiError);
    await expect(request).rejects.toMatchObject({ status: 502, code: null });
    expect(fetchCalls).toBe(1);
  });
});

describe('rate-limit retry logging', () => {
  const BOT_TOKEN = 'SENTINEL-BOT-TOKEN';
  const BODY_SENTINEL = 'SENTINEL-BODY-MESSAGE';
  const QUERY_SENTINEL = 'SENTINEL-QUERY';
  const CHANNEL_ID = '1234567890123456789';
  const PATH = `/channels/${CHANNEL_ID}/messages?after=${QUERY_SENTINEL}&limit=100`;

  function rateLimited(retryAfter: number, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify({ message: BODY_SENTINEL, retry_after: retryAfter, global: false, code: 0 }), {
      status: 429,
      headers,
    });
  }

  function sequence(responses: Response[]): typeof fetch {
    return (async () => responses.shift()!) as unknown as typeof fetch;
  }

  function rawLogLines(): string[] {
    return vi.mocked(console.log).mock.calls.map(([line]) => String(line));
  }

  it('logs one templated line per retried 429, with the slept delay and the rate-limit headers', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const sleep = vi.fn(async () => {});
    const fetchImpl = sequence([
      rateLimited(7.5, { 'X-RateLimit-Scope': 'shared', 'X-RateLimit-Bucket': 'abcd1234' }),
      new Response(JSON.stringify({ id: 'ok' }), { status: 200 }),
    ]);
    const client = createDiscordRestClient({ botToken: BOT_TOKEN, fetchImpl, sleep });

    await expect(client.request('GET', PATH)).resolves.toEqual({ id: 'ok' });

    expect(sleep).toHaveBeenCalledWith(5000);
    const lines = rawLogLines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      event: 'discord.rate_limited',
      method: 'GET',
      route: '/channels/{id}/messages',
      retryAfterMs: '5000',
      attempt: '1',
      rateLimitScope: 'shared',
      rateLimitBucket: 'abcd1234',
      rateLimitGlobal: 'false',
    });
    for (const sentinel of [BOT_TOKEN, BODY_SENTINEL, QUERY_SENTINEL, CHANNEL_ID]) {
      expect(lines[0]).not.toContain(sentinel);
    }
  });

  it('logs each retried 429 and leaves the final one to the caller', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = sequence([
      rateLimited(0.25, { 'X-RateLimit-Global': 'true', 'X-RateLimit-Scope': 'global' }),
      rateLimited(0.5),
      rateLimited(0.75),
    ]);
    const client = createDiscordRestClient({ botToken: BOT_TOKEN, fetchImpl, sleep: async () => {} });

    const request = client.request('POST', `/channels/${CHANNEL_ID}/messages`);
    await expect(request).rejects.toBeInstanceOf(DiscordApiError);
    await expect(request).rejects.toMatchObject({ status: 429, code: 0 });

    expect(rawLogLines().map((line) => JSON.parse(line))).toEqual([
      {
        event: 'discord.rate_limited',
        method: 'POST',
        route: '/channels/{id}/messages',
        retryAfterMs: '250',
        attempt: '1',
        rateLimitScope: 'global',
        rateLimitGlobal: 'true',
      },
      {
        event: 'discord.rate_limited',
        method: 'POST',
        route: '/channels/{id}/messages',
        retryAfterMs: '500',
        attempt: '2',
        rateLimitGlobal: 'false',
      },
    ]);
  });

  it('logs no retry line for a 500', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = sequence([new Response(null, { status: 500 })]);
    const client = createDiscordRestClient({ botToken: BOT_TOKEN, fetchImpl, sleep: async () => {} });

    await expect(client.request('GET', PATH)).rejects.toMatchObject({ status: 500 });
    expect(rawLogLines()).toEqual([]);
  });
});

describe('slow request logging', () => {
  const PATH = '/guilds/1234567890123456789/channels?with_counts=SENTINEL-QUERY';

  /** A clock that reads `start` when the request begins and `end` when it settles. */
  function clock(start: number, end: number): () => number {
    return vi.fn<() => number>().mockReturnValueOnce(start).mockReturnValueOnce(end);
  }

  function logLines(): unknown[] {
    return vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)));
  }

  it('logs a request that took a second or longer, with its outcome', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const client = createDiscordRestClient({ botToken: 'SENTINEL-BOT-TOKEN', fetchImpl, now: clock(0, 1500) });

    await client.request('GET', PATH);

    expect(logLines()).toEqual([
      {
        event: 'discord.slow_request',
        method: 'GET',
        route: '/guilds/{id}/channels',
        durationMs: '1500',
        attempt: '1',
        httpStatus: '200',
      },
    ]);
  });

  it('logs a request that timed out, and still throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = (async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const client = createDiscordRestClient({ botToken: 'SENTINEL-BOT-TOKEN', fetchImpl, now: clock(0, 10000) });

    await expect(client.request('GET', PATH)).rejects.toMatchObject({ name: 'TimeoutError' });

    expect(logLines()).toEqual([
      {
        event: 'discord.slow_request',
        method: 'GET',
        route: '/guilds/{id}/channels',
        durationMs: '10000',
        attempt: '1',
        failure: 'timeout',
      },
    ]);
  });

  it('logs nothing for a request under a second', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const client = createDiscordRestClient({ botToken: 'SENTINEL-BOT-TOKEN', fetchImpl, now: clock(0, 999) });

    await client.request('GET', PATH);

    expect(logLines()).toEqual([]);
  });
});

describe('discordRouteTemplate', () => {
  it('replaces every numeric id segment and drops the query string', () => {
    expect(discordRouteTemplate('/channels/1234567890123456789/messages/9876543210987654321')).toBe(
      '/channels/{id}/messages/{id}',
    );
    expect(discordRouteTemplate('/channels/1234567890123456789/messages?after=1234567890123456788&limit=100')).toBe(
      '/channels/{id}/messages',
    );
  });

  it('replaces the interaction token in a webhook path', () => {
    expect(discordRouteTemplate('/webhooks/1234567890123456789/SENTINEL-INTERACTION-TOKEN/messages/@original')).toBe(
      '/webhooks/{id}/{token}/messages/@original',
    );
  });

  it('keeps only lowercase route words such as reactions and @me', () => {
    expect(
      discordRouteTemplate('/channels/1234567890123456789/messages/9876543210987654321/reactions/%F0%9F%93%8E/@me'),
    ).toBe('/channels/{id}/messages/{id}/reactions/{value}/@me');
  });

  it('replaces any segment that is not a route word, wherever it sits', () => {
    expect(discordRouteTemplate('/interactions/1234567890123456789/SENTINEL.Token-value_x/callback')).toBe(
      '/interactions/{id}/{value}/callback',
    );
  });
});

describe('describeDiscordFailure', () => {
  it('classes an exhausted rate limit as http with its status and Discord code', () => {
    const error = new DiscordApiError('x', { status: 429, code: 0 });
    expect(describeDiscordFailure(error)).toEqual({ failure: 'http', httpStatus: '429', discordCode: '0' });
  });

  it('omits the Discord code when the response carried none', () => {
    const error = new DiscordApiError('x', { status: 503, code: null });
    expect(describeDiscordFailure(error)).toEqual({ failure: 'http', httpStatus: '503' });
  });

  it('classes the fetch timeout as timeout', () => {
    const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(describeDiscordFailure(error)).toEqual({ failure: 'timeout' });
  });

  it('classes an abort as timeout', () => {
    const error = new DOMException('This operation was aborted', 'AbortError');
    expect(describeDiscordFailure(error)).toEqual({ failure: 'timeout' });
  });

  it('classes anything else as network', () => {
    expect(describeDiscordFailure(new TypeError('fetch failed'))).toEqual({ failure: 'network' });
    expect(describeDiscordFailure('not an error')).toEqual({ failure: 'network' });
  });

  it('never reads the error message, which can echo a response body', () => {
    for (const error of [
      new DiscordApiError('x', { status: 500, code: null }),
      new DOMException('x', 'TimeoutError'),
      new TypeError('x'),
    ]) {
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('message was read');
        },
      });
      expect(() => describeDiscordFailure(error)).not.toThrow();
    }
  });
});
