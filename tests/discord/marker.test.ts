import { afterEach, describe, expect, test, vi } from 'vitest';
import { createArchiveMarker } from '@/lib/discord/marker';

const BOT_TOKEN = 'bot-token-value';
const SOURCE_CHANNEL_ID = '1539212298600718417';
const SOURCE_MESSAGE_ID = '1539212298600718418';

// The path segment Discord's reaction endpoints require: U+1F4CE (📎)
// percent-encoded as UTF-8 bytes. This is the one place the task can
// silently half-work, so the test asserts the literal segment rather than
// trusting `encodeURIComponent` to have been called correctly somewhere.
const ENCODED_MARKER_EMOJI = '%F0%9F%93%8E';

type StubResponse = { status: number; body: unknown };

function json(body: unknown, status = 200): StubResponse {
  return { status, body };
}

type Call = { url: string; method: string; headers: Headers };

/** Mirrors the stubbing pattern in tests/discord/archive-message.test.ts. */
function stubFetch(responses: readonly StubResponse[]) {
  const calls: Call[] = [];
  let index = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const next = responses[index];
    index += 1;
    if (next === undefined) {
      throw new Error(`unexpected fetch call ${index}: ${String(url)}`);
    }
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });
    return new Response(next.body === null ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createArchiveMarker', () => {
  test('add() PUTs the bot marker reaction with the emoji correctly percent-encoded', async () => {
    const { fetchImpl, calls } = stubFetch([json(null, 204)]);
    const marker = createArchiveMarker({ botToken: BOT_TOKEN, fetchImpl });

    await marker.add(SOURCE_CHANNEL_ID, SOURCE_MESSAGE_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe(
      `https://discord.com/api/v10/channels/${SOURCE_CHANNEL_ID}/messages/${SOURCE_MESSAGE_ID}/reactions/${ENCODED_MARKER_EMOJI}/@me`
    );
  });

  test('remove() DELETEs the bot marker reaction at the same path', async () => {
    const { fetchImpl, calls } = stubFetch([json(null, 204)]);
    const marker = createArchiveMarker({ botToken: BOT_TOKEN, fetchImpl });

    await marker.remove(SOURCE_CHANNEL_ID, SOURCE_MESSAGE_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(
      `https://discord.com/api/v10/channels/${SOURCE_CHANNEL_ID}/messages/${SOURCE_MESSAGE_ID}/reactions/${ENCODED_MARKER_EMOJI}/@me`
    );
  });

  test('authenticates as the bot, and only the bot -- the path targets @me, never a specific user', async () => {
    const { fetchImpl, calls } = stubFetch([json(null, 204)]);
    const marker = createArchiveMarker({ botToken: BOT_TOKEN, fetchImpl });

    await marker.add(SOURCE_CHANNEL_ID, SOURCE_MESSAGE_ID);

    expect(calls[0].headers.get('Authorization')).toBe(`Bot ${BOT_TOKEN}`);
    expect(calls[0].url.endsWith('/@me')).toBe(true);
  });

  test('add() never throws, even when Discord rejects the call', async () => {
    const { fetchImpl } = stubFetch([json({ code: 50001, message: 'Missing Access' }, 403)]);
    const marker = createArchiveMarker({ botToken: BOT_TOKEN, fetchImpl });

    await expect(marker.add(SOURCE_CHANNEL_ID, SOURCE_MESSAGE_ID)).resolves.toBeUndefined();
  });

  test('remove() never throws, even when Discord rejects the call', async () => {
    const { fetchImpl } = stubFetch([json({ code: 0, message: 'Internal Server Error' }, 500)]);
    const marker = createArchiveMarker({ botToken: BOT_TOKEN, fetchImpl });

    await expect(marker.remove(SOURCE_CHANNEL_ID, SOURCE_MESSAGE_ID)).resolves.toBeUndefined();
  });

  test('add() never throws even when fetch itself rejects (network failure)', async () => {
    const fetchImpl = (async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;
    const marker = createArchiveMarker({ botToken: BOT_TOKEN, fetchImpl });

    await expect(marker.add(SOURCE_CHANNEL_ID, SOURCE_MESSAGE_ID)).resolves.toBeUndefined();
  });

  test('a failure is logged with the identifiers and an error code, never a message body', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fetchImpl } = stubFetch([json({ code: 50001, message: 'Missing Access' }, 403)]);
    const marker = createArchiveMarker({ botToken: BOT_TOKEN, fetchImpl });

    await marker.add(SOURCE_CHANNEL_ID, SOURCE_MESSAGE_ID);

    expect(log).toHaveBeenCalledTimes(1);
    const written = log.mock.calls.map(String).join('\n');
    expect(written).toContain(SOURCE_MESSAGE_ID);
    expect(written).toContain('50001');
  });

  test('a success is not logged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fetchImpl } = stubFetch([json(null, 204)]);
    const marker = createArchiveMarker({ botToken: BOT_TOKEN, fetchImpl });

    await marker.add(SOURCE_CHANNEL_ID, SOURCE_MESSAGE_ID);

    expect(log).not.toHaveBeenCalled();
  });

  test('the returned surface exposes only add and remove -- no way to read reactions, so a user copy of the emoji can never be read back as a clipper signal', () => {
    const marker = createArchiveMarker({ botToken: BOT_TOKEN, fetchImpl: stubFetch([]).fetchImpl });

    expect(Object.keys(marker).sort()).toEqual(['add', 'remove']);
  });
});
