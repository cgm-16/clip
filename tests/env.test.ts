import { describe, expect, test } from 'vitest';
import { parseEnv } from '@/lib/env';

const valid = {
  DATABASE_URL: 'postgresql://clip:pw@localhost:5432/clip',
  DISCORD_APPLICATION_ID: '1539212298600718416',
  DISCORD_PUBLIC_KEY: '48d8b61da572482e31708b55948bfdcab382f177953cfd6dd4912d8158557f3d',
  DISCORD_BOT_TOKEN: 'bot-token-value',
  ADMIN_SESSION_SECRET: 'x'.repeat(32),
  PUBLIC_BASE_URL: 'https://clipendpoint.cc',
};

describe('parseEnv', () => {
  test('returns typed configuration for a valid environment', () => {
    expect(parseEnv(valid)).toMatchObject({
      DATABASE_URL: valid.DATABASE_URL,
      PUBLIC_BASE_URL: 'https://clipendpoint.cc',
    });
  });

  test('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });

  test('rejects an ADMIN_SESSION_SECRET shorter than 32 characters', () => {
    expect(() => parseEnv({ ...valid, ADMIN_SESSION_SECRET: 'x'.repeat(31) })).toThrow(
      /ADMIN_SESSION_SECRET/,
    );
  });

  test('rejects a PUBLIC_BASE_URL that is not a URL', () => {
    expect(() => parseEnv({ ...valid, PUBLIC_BASE_URL: 'clipendpoint.cc' })).toThrow(
      /PUBLIC_BASE_URL/,
    );
  });

  test('rejects a PUBLIC_BASE_URL with a trailing slash so callback URLs cannot double up', () => {
    expect(() => parseEnv({ ...valid, PUBLIC_BASE_URL: 'https://clipendpoint.cc/' })).toThrow(
      /PUBLIC_BASE_URL/,
    );
  });

  test('names every offending variable at once, not just the first', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL[\s\S]*PUBLIC_BASE_URL/);
  });
});
