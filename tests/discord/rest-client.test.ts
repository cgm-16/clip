import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiscordRestClient, DiscordApiError } from '@/lib/discord/rest-client';

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
