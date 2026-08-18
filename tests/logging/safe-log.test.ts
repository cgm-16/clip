import { afterEach, describe, expect, test, vi } from 'vitest';
import { logClipEvent, type SafeClipLog } from '@/lib/logging/safe-log';

// Discord message bodies must never reach the log stream (product spec §12).
// This suite proves that in the two places it can leak from: a call site
// typed against `SafeClipLog` (caught by the compiler) and a call site that
// isn't (caught by the allowlist at runtime).

function loggedPayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  const [line] = spy.mock.calls[0] as [string];
  return JSON.parse(line);
}

describe('logClipEvent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('rejects content, embeds and attachments at the type level', () => {
    // console.log is mocked only to keep test output pristine; this test's
    // actual assertion is the three @ts-expect-error directives below,
    // enforced by `tsc --noEmit` — nothing about runtime output is checked.
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // @ts-expect-error content must never be part of a SafeClipLog call
    logClipEvent({ event: 'clip.created', content: 'the actual message text' });
    // @ts-expect-error embeds must never be part of a SafeClipLog call
    logClipEvent({ event: 'clip.created', embeds: [{ title: 'leaked' }] });
    // @ts-expect-error attachments must never be part of a SafeClipLog call
    logClipEvent({ event: 'clip.created', attachments: [{ url: 'https://example.com/x.png' }] });
  });

  test('drops content, embeds and attachments that arrive from an untyped call site', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Simulates a payload crossing an untyped boundary (e.g. JSON parsed
    // from an external source) that happens to carry unsafe fields.
    const fromUntypedBoundary: SafeClipLog = JSON.parse(
      JSON.stringify({
        event: 'clip.created',
        guildId: 'guild-1',
        content: 'the actual message text',
        embeds: [{ title: 'leaked' }],
        attachments: [{ url: 'https://example.com/x.png' }],
      }),
    );

    logClipEvent(fromUntypedBoundary);

    const payload = loggedPayload(spy);
    expect(payload).not.toHaveProperty('content');
    expect(payload).not.toHaveProperty('embeds');
    expect(payload).not.toHaveProperty('attachments');
    expect(payload).toMatchObject({ event: 'clip.created', guildId: 'guild-1' });
  });

  test('keeps only allowlisted keys even when the arrival carries other unexpected fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // A field nobody allowlisted (not "content", not on any denylist) must
    // still be dropped: the safety property comes from the allowlist, not
    // from recognizing specific forbidden names.
    const withSurpriseField: SafeClipLog = JSON.parse(
      JSON.stringify({ event: 'clip.created', someFutureField: 'unexpected' }),
    );

    logClipEvent(withSurpriseField);

    const payload = loggedPayload(spy);
    expect(payload).not.toHaveProperty('someFutureField');
    expect(payload).toEqual({ event: 'clip.created' });
  });

  test('logs a state transition', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logClipEvent({
      event: 'clip.state_changed',
      guildId: 'guild-1',
      sourceMessageId: 'msg-1',
      stateFrom: 'PENDING',
      stateTo: 'ACTIVE',
    });

    expect(loggedPayload(spy)).toEqual({
      event: 'clip.state_changed',
      guildId: 'guild-1',
      sourceMessageId: 'msg-1',
      stateFrom: 'PENDING',
      stateTo: 'ACTIVE',
    });
  });

  test('logs an error code', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logClipEvent({
      event: 'clip.archive_failed',
      guildId: 'guild-1',
      sourceMessageId: 'msg-1',
      errorCode: '160014',
    });

    expect(loggedPayload(spy)).toEqual({
      event: 'clip.archive_failed',
      guildId: 'guild-1',
      sourceMessageId: 'msg-1',
      errorCode: '160014',
    });
  });

  test('omits optional fields that were not provided rather than logging them as undefined', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logClipEvent({ event: 'clip.created' });

    expect(loggedPayload(spy)).toEqual({ event: 'clip.created' });
  });
});
