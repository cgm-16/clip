import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDiscordArchiveGateway } from '@/lib/discord/archive-message';
import { ArchiveCreationFailedError, ArchiveTargetUnavailableError } from '@/lib/clip/types';

const BOT_TOKEN = 'bot-token-value';
const GUILD_ID = '1539212298600718416';
const SOURCE_CHANNEL_ID = '1539212298600718417';
const SOURCE_MESSAGE_ID = '1539212298600718418';
const AUTHOR_ID = '1539212298600718419';
const ARCHIVE_CHANNEL_ID = '1539212298600718420';

const PROVENANCE_ID = '2000000000000000001';
const FORWARD_ID = '2000000000000000002';

// Discord message types. Only these four can be forwarded (spec §6.3).
const DEFAULT = 0;
const REPLY = 19;
const CHAT_INPUT_COMMAND = 20;
const CONTEXT_MENU_COMMAND = 23;
// A poll. Deliberately one of the types the spec names as unforwardable.
const POLL = 46;

const ORIGINAL_TIMESTAMP = '2026-08-19T12:34:56.000+00:00';
const ORIGINAL_UNIX = Math.floor(Date.parse(ORIGINAL_TIMESTAMP) / 1000);

/**
 * The body of the source message, which must never reach a log or Postgres.
 * Distinctive so a leak is findable by substring rather than by inspection.
 */
const SECRET_BODY = 'SENSITIVE-MESSAGE-BODY-3f9a2c';

const input = {
  guildId: GUILD_ID,
  archiveChannelId: ARCHIVE_CHANNEL_ID,
  sourceChannelId: SOURCE_CHANNEL_ID,
  sourceMessageId: SOURCE_MESSAGE_ID,
  sourceAuthorUserId: AUTHOR_ID,
};

type StubResponse = { status: number; body: unknown };

function json(body: unknown, status = 200): StubResponse {
  return { status, body };
}

function sourceMessage(type: number): StubResponse {
  return json({
    id: SOURCE_MESSAGE_ID,
    type,
    channel_id: SOURCE_CHANNEL_ID,
    timestamp: ORIGINAL_TIMESTAMP,
    content: SECRET_BODY,
    author: { id: AUTHOR_ID, username: 'author' },
  });
}

type Call = { url: string; method: string; body: Record<string, unknown> | null; headers: Headers };

/**
 * A fetch double that answers each call from a queue, recording what was sent.
 *
 * The queue is ordered rather than routed by URL on purpose: the two-message
 * representation is defined by its *order* -- provenance first, then the
 * forward -- and a router keyed on URL would answer both from the same entry
 * and hide a gateway that posted them the wrong way round.
 */
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
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
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

describe('createArchiveMessage', () => {
  test('posts the provenance message and then the forward, returning both ids', async () => {
    const { fetchImpl, calls } = stubFetch([
      sourceMessage(DEFAULT),
      json({ id: PROVENANCE_ID }),
      json({ id: FORWARD_ID }),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    const archive = await gateway.createArchiveMessage(input);

    expect(archive).toEqual({
      provenanceMessageId: PROVENANCE_ID,
      forwardMessageId: FORWARD_ID,
    });

    const [read, provenance, forward] = calls;
    expect(read.method).toBe('GET');
    expect(read.url).toContain(`/channels/${SOURCE_CHANNEL_ID}/messages/${SOURCE_MESSAGE_ID}`);

    expect(provenance.method).toBe('POST');
    expect(provenance.url).toContain(`/channels/${ARCHIVE_CHANNEL_ID}/messages`);

    expect(forward.method).toBe('POST');
    expect(forward.url).toContain(`/channels/${ARCHIVE_CHANNEL_ID}/messages`);
  });

  test('authenticates every call as the bot', async () => {
    const { fetchImpl, calls } = stubFetch([
      sourceMessage(DEFAULT),
      json({ id: PROVENANCE_ID }),
      json({ id: FORWARD_ID }),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await gateway.createArchiveMessage(input);

    for (const call of calls) {
      expect(call.headers.get('Authorization')).toBe(`Bot ${BOT_TOKEN}`);
    }
  });

  test('the forward carries no additional content, which Discord rejects with 160011', async () => {
    const { fetchImpl, calls } = stubFetch([
      sourceMessage(DEFAULT),
      json({ id: PROVENANCE_ID }),
      json({ id: FORWARD_ID }),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await gateway.createArchiveMessage(input);

    const forward = calls[2].body!;
    expect(forward.message_reference).toEqual({
      type: 1,
      message_id: SOURCE_MESSAGE_ID,
      channel_id: SOURCE_CHANNEL_ID,
      guild_id: GUILD_ID,
    });
    expect(forward).not.toHaveProperty('content');
    expect(forward).not.toHaveProperty('embeds');
    expect(forward).not.toHaveProperty('components');
  });

  test('the provenance message carries author, channel, original timestamp and a jump link', async () => {
    const { fetchImpl, calls } = stubFetch([
      sourceMessage(DEFAULT),
      json({ id: PROVENANCE_ID }),
      json({ id: FORWARD_ID }),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await gateway.createArchiveMessage(input);

    const content = calls[1].body!.content as string;
    expect(content).toContain(`<@${AUTHOR_ID}>`);
    expect(content).toContain(`<#${SOURCE_CHANNEL_ID}>`);
    expect(content).toContain(`<t:${ORIGINAL_UNIX}:f>`);
    expect(content).toContain(
      `https://discord.com/channels/${GUILD_ID}/${SOURCE_CHANNEL_ID}/${SOURCE_MESSAGE_ID}`
    );
  });

  test('the provenance message never carries the source body', async () => {
    const { fetchImpl, calls } = stubFetch([
      sourceMessage(DEFAULT),
      json({ id: PROVENANCE_ID }),
      json({ id: FORWARD_ID }),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await gateway.createArchiveMessage(input);

    expect(JSON.stringify(calls[1].body)).not.toContain(SECRET_BODY);
  });

  test('no log line carries the source body', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetchImpl } = stubFetch([
      sourceMessage(DEFAULT),
      json({ id: PROVENANCE_ID }),
      json({ id: FORWARD_ID }),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await gateway.createArchiveMessage(input);

    const written = [...log.mock.calls, ...error.mock.calls].flat().map(String).join('\n');
    expect(written).not.toContain(SECRET_BODY);
  });

  test.each([
    ['DEFAULT', DEFAULT],
    ['REPLY', REPLY],
    ['CHAT_INPUT_COMMAND', CHAT_INPUT_COMMAND],
    ['CONTEXT_MENU_COMMAND', CONTEXT_MENU_COMMAND],
  ])('forwards a %s message', async (_name, type) => {
    const { fetchImpl } = stubFetch([
      sourceMessage(type),
      json({ id: PROVENANCE_ID }),
      json({ id: FORWARD_ID }),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await expect(gateway.createArchiveMessage(input)).resolves.toBeDefined();
  });

  test('rejects an unforwardable type before writing anything to Discord', async () => {
    const { fetchImpl, calls } = stubFetch([sourceMessage(POLL)]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await expect(gateway.createArchiveMessage(input)).rejects.toBeInstanceOf(
      ArchiveTargetUnavailableError
    );
    // The read only. Rejecting after posting provenance would leave an orphan
    // for a message that was never archivable in the first place.
    expect(calls).toHaveLength(1);
  });

  test('rejects a source message the bot cannot see', async () => {
    const { fetchImpl } = stubFetch([json({ code: 50001, message: 'Missing Access' }, 403)]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await expect(gateway.createArchiveMessage(input)).rejects.toBeInstanceOf(
      ArchiveTargetUnavailableError
    );
  });

  test('rejects a source message that no longer exists', async () => {
    const { fetchImpl } = stubFetch([json({ code: 10008, message: 'Unknown Message' }, 404)]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await expect(gateway.createArchiveMessage(input)).rejects.toBeInstanceOf(
      ArchiveTargetUnavailableError
    );
  });

  test('maps 160014 on the forward to an unavailable target', async () => {
    const { fetchImpl } = stubFetch([
      sourceMessage(DEFAULT),
      json({ id: PROVENANCE_ID }),
      json({ code: 160014, message: 'Cannot forward a message the app cannot read' }, 400),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await expect(gateway.createArchiveMessage(input)).rejects.toBeInstanceOf(
      ArchiveTargetUnavailableError
    );
  });

  test('a forward failure reports the orphaned provenance id so the caller can clean up', async () => {
    const { fetchImpl } = stubFetch([
      sourceMessage(DEFAULT),
      json({ id: PROVENANCE_ID }),
      json({ code: 0, message: 'Internal Server Error' }, 500),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    const error = await gateway.createArchiveMessage(input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ArchiveCreationFailedError);
    expect((error as ArchiveCreationFailedError).orphanedProvenanceMessageId).toBe(PROVENANCE_ID);
    expect((error as ArchiveCreationFailedError).retryable).toBe(true);
  });

  test('a provenance failure leaves no orphan to clean up', async () => {
    const { fetchImpl } = stubFetch([
      sourceMessage(DEFAULT),
      json({ code: 0, message: 'Internal Server Error' }, 500),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    const error = await gateway.createArchiveMessage(input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ArchiveCreationFailedError);
    expect((error as ArchiveCreationFailedError).orphanedProvenanceMessageId).toBeNull();
  });

  test('retries after a 429 and succeeds', async () => {
    const { fetchImpl, calls } = stubFetch([
      sourceMessage(DEFAULT),
      json({ retry_after: 0.001, global: false }, 429),
      json({ id: PROVENANCE_ID }),
      json({ id: FORWARD_ID }),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    const archive = await gateway.createArchiveMessage(input);

    expect(archive.provenanceMessageId).toBe(PROVENANCE_ID);
    expect(calls).toHaveLength(4);
  });

  test('gives up rather than retrying a rate limit forever', async () => {
    const rateLimited = json({ retry_after: 0.001, global: false }, 429);
    const { fetchImpl } = stubFetch([
      sourceMessage(DEFAULT),
      rateLimited,
      rateLimited,
      rateLimited,
      rateLimited,
      rateLimited,
      rateLimited,
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await expect(gateway.createArchiveMessage(input)).rejects.toBeInstanceOf(
      ArchiveCreationFailedError
    );
  });
});

describe('deleteArchiveMessage', () => {
  test('deletes both messages of the pair', async () => {
    const { fetchImpl, calls } = stubFetch([json(null, 204), json(null, 204)]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await gateway.deleteArchiveMessage(ARCHIVE_CHANNEL_ID, {
      provenanceMessageId: PROVENANCE_ID,
      forwardMessageId: FORWARD_ID,
    });

    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
    expect(calls[0].url).toContain(`/channels/${ARCHIVE_CHANNEL_ID}/messages/${PROVENANCE_ID}`);
    expect(calls[1].url).toContain(`/channels/${ARCHIVE_CHANNEL_ID}/messages/${FORWARD_ID}`);
  });

  test('an already-deleted message is not an error', async () => {
    const { fetchImpl } = stubFetch([
      json({ code: 10008, message: 'Unknown Message' }, 404),
      json(null, 204),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await expect(
      gateway.deleteArchiveMessage(ARCHIVE_CHANNEL_ID, {
        provenanceMessageId: PROVENANCE_ID,
        forwardMessageId: FORWARD_ID,
      })
    ).resolves.toBeUndefined();
  });

  test('deletes the forward even when the provenance message is already gone', async () => {
    const { fetchImpl, calls } = stubFetch([
      json({ code: 10008, message: 'Unknown Message' }, 404),
      json(null, 204),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await gateway.deleteArchiveMessage(ARCHIVE_CHANNEL_ID, {
      provenanceMessageId: PROVENANCE_ID,
      forwardMessageId: FORWARD_ID,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain(FORWARD_ID);
  });

  test('a real failure on either message is reported', async () => {
    const { fetchImpl } = stubFetch([
      json(null, 204),
      json({ code: 0, message: 'Internal Server Error' }, 500),
    ]);
    const gateway = createDiscordArchiveGateway({ botToken: BOT_TOKEN, fetchImpl });

    await expect(
      gateway.deleteArchiveMessage(ARCHIVE_CHANNEL_ID, {
        provenanceMessageId: PROVENANCE_ID,
        forwardMessageId: FORWARD_ID,
      })
    ).rejects.toBeDefined();
  });
});
