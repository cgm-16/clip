import { afterEach, describe, expect, test, vi } from 'vitest';
import { DISCORD_COMMANDS, SETUP_COMMAND_NAME } from '@/lib/discord/commands';
import { main } from '../../scripts/register-discord-commands';

const validEnv = {
  DISCORD_APPLICATION_ID: 'app-1',
  DISCORD_BOT_TOKEN: 'bot-token-value',
  DISCORD_TEST_GUILD_ID: 'guild-1',
};

// Someone running this script by accident must never fire a real Discord
// request, so every scenario here proves that through the fetch mock rather
// than by reading the parsed flag.
describe('register-discord-commands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a bare invocation with a fully valid environment makes zero network calls', async () => {
    const fetchImpl = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await main([], { fetchImpl, envSource: validEnv });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a bare invocation with no environment at all makes zero network calls', async () => {
    const fetchImpl = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await main([], { fetchImpl, envSource: {} });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a dry run prints the command payloads', async () => {
    const fetchImpl = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main([], { fetchImpl, envSource: validEnv });

    const printed = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(printed).toContain(SETUP_COMMAND_NAME);
  });

  test('--register sends one PUT to the guild-scoped commands endpoint with the bot token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['--register'], { fetchImpl, envSource: validEnv });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/applications/app-1/guilds/guild-1/commands');
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({ Authorization: 'Bot bot-token-value' });
    expect(JSON.parse(init.body as string)).toEqual(DISCORD_COMMANDS);
  });

  test('--register with a missing environment variable throws before any network call', async () => {
    const fetchImpl = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { DISCORD_BOT_TOKEN: _omitted, ...incomplete } = validEnv;

    await expect(main(['--register'], { fetchImpl, envSource: incomplete })).rejects.toThrow(
      /DISCORD_BOT_TOKEN/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('--register propagates a non-ok Discord response as a thrown error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(main(['--register'], { fetchImpl, envSource: validEnv })).rejects.toThrow(
      /401/,
    );
  });
});
