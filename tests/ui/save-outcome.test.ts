import { expect, test } from 'vitest';
import { saveOutcomeOf } from '@/app/setup/[token]/setup-client';

test('a 409 CLIP_IN_PROGRESS body maps to the in-progress outcome', async () => {
  const response = Response.json({ reason: 'CLIP_IN_PROGRESS' }, { status: 409 });
  expect(await saveOutcomeOf(response)).toEqual({ kind: 'clip-in-progress' });
});

test('a 409 LIVE_CLIPS body maps to the live-clips outcome', async () => {
  const response = Response.json({ reason: 'LIVE_CLIPS' }, { status: 409 });
  expect(await saveOutcomeOf(response)).toEqual({ kind: 'live-clips' });
});

test('a 409 with an unreadable body falls back to the live-clips outcome', async () => {
  expect(await saveOutcomeOf(new Response('not json', { status: 409 }))).toEqual({ kind: 'live-clips' });
});
