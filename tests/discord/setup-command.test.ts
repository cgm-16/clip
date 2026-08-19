import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SETUP_COMMAND_NAME } from '@/lib/discord/commands';
import { DISCORD_COPY } from '@/lib/discord/copy';

const issueSetupToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/admin-session/service', () => ({ issueSetupToken }));

const { POST } = await import('@/app/api/discord/interactions/route');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

const BASE_URL = 'https://clipendpoint.cc';
// Deliberately not BASE_URL. The setup link must be built from
// PUBLIC_BASE_URL, never from the request's own origin, which is
// Host-header-derived and attacker-influenceable behind a proxy. Keeping the
// two distinct is what lets the link assertions tell them apart.
const REQUEST_ORIGIN = 'https://ingress.internal';
const GUILD_ID = '1539212298600718416';
const USER_ID = '1539212298600718417';
const MANAGE_GUILD_ONLY = (1n << 5n).toString();
// Every permission below MANAGE_GUILD, and nothing above it.
const NO_MANAGE_GUILD = ((1n << 5n) - 1n).toString();

const APPLICATION_COMMAND_INTERACTION_TYPE = 2;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const EPHEMERAL_FLAG = 64;

function signedRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const timestamp = '1700000000';
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');

  return new Request(`${REQUEST_ORIGIN}/api/discord/interactions`, {
    method: 'POST',
    headers: {
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    },
    body,
  });
}

// A request carrying whatever headers the caller supplies and no valid
// signature over the body.
function unsignedRequest(payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${REQUEST_ORIGIN}/api/discord/interactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

function setupInvocation(permissions: string): unknown {
  return {
    type: APPLICATION_COMMAND_INTERACTION_TYPE,
    guild_id: GUILD_ID,
    data: { id: '1539212298600718418', name: SETUP_COMMAND_NAME, type: 1 },
    member: { user: { id: USER_ID }, permissions },
  };
}

async function interactionResponse(payload: unknown) {
  const response = await POST(signedRequest(payload));
  expect(response.status).toBe(200);
  return response.json();
}

describe('/setup interaction', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgresql://clip:pw@localhost:5432/clip');
    vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
    vi.stubEnv('DISCORD_PUBLIC_KEY', publicKeyHex);
    vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('PUBLIC_BASE_URL', BASE_URL);
    issueSetupToken.mockResolvedValue({ token: 'setup-bearer', expiresAt: new Date() });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  test('an administrator receives an ephemeral one-time setup link', async () => {
    const body = await interactionResponse(setupInvocation(MANAGE_GUILD_ONLY));

    expect(issueSetupToken).toHaveBeenCalledExactlyOnceWith(GUILD_ID, USER_ID);
    expect(body).toEqual({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `${BASE_URL}/setup/setup-bearer`,
        // Without this flag the link is posted into the channel, where anyone
        // present could spend the admin's one-time token before they do.
        flags: EPHEMERAL_FLAG,
      },
    });
  });

  test('a member without MANAGE_GUILD gets a private denial and no token', async () => {
    const body = await interactionResponse(setupInvocation(NO_MANAGE_GUILD));

    expect(issueSetupToken).not.toHaveBeenCalled();
    expect(body).toEqual({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      // A refused authorization attempt is nobody else's business either.
      data: { content: DISCORD_COPY.noPermission, flags: EPHEMERAL_FLAG },
    });
  });

  test('MANAGE_GUILD is honoured in a bitfield wider than Number can hold', async () => {
    // Discord's permission bits run past 2^53, so a member holding a modern
    // high bit reads back as a permission set no Number can represent.
    const wide = ((1n << 60n) + (1n << 5n)).toString();

    const body = await interactionResponse(setupInvocation(wide));

    expect(issueSetupToken).toHaveBeenCalledExactlyOnceWith(GUILD_ID, USER_ID);
    expect(body.data.content).toBe(`${BASE_URL}/setup/setup-bearer`);
  });

  test('a high bit that is not MANAGE_GUILD does not grant setup', async () => {
    const body = await interactionResponse(setupInvocation((1n << 60n).toString()));

    expect(issueSetupToken).not.toHaveBeenCalled();
    expect(body.data.content).toBe(DISCORD_COPY.noPermission);
  });

  test('`/setup` outside a guild is denied rather than throwing', async () => {
    // A DM invocation carries `user` instead of `member` and no `guild_id`,
    // so there is no guild to configure and no permission set to check.
    const body = await interactionResponse({
      type: APPLICATION_COMMAND_INTERACTION_TYPE,
      data: { id: '1539212298600718418', name: SETUP_COMMAND_NAME, type: 1 },
      user: { id: USER_ID },
    });

    expect(issueSetupToken).not.toHaveBeenCalled();
    expect(body).toEqual({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: DISCORD_COPY.noPermission, flags: EPHEMERAL_FLAG },
    });
  });

  test('the bearer token appears only inside the link, and never on the denial path', async () => {
    const granted = await POST(signedRequest(setupInvocation(MANAGE_GUILD_ONLY)));
    const grantedBody = await granted.text();

    // Exactly one occurrence, and it is the one inside the setup URL. A token
    // echoed anywhere else in the payload is a second place it can leak from.
    expect(grantedBody.split('setup-bearer')).toHaveLength(2);
    expect(grantedBody).toContain(`${BASE_URL}/setup/setup-bearer`);

    const denial = await POST(signedRequest(setupInvocation(NO_MANAGE_GUILD)));

    expect(await denial.text()).not.toContain('setup-bearer');
  });

  test('an unsigned /setup invocation is rejected and issues no token', async () => {
    // Routing /setup ahead of signature verification would let an
    // unauthenticated caller mint a live admin token for an arbitrary guild.
    // Nothing else in the suite fails if that ordering is inverted.
    const response = await POST(unsignedRequest(setupInvocation(MANAGE_GUILD_ONLY)));

    expect(response.status).toBe(401);
    expect(issueSetupToken).not.toHaveBeenCalled();
  });

  test('a badly signed /setup invocation is rejected and issues no token', async () => {
    const response = await POST(
      unsignedRequest(setupInvocation(MANAGE_GUILD_ONLY), {
        'X-Signature-Ed25519': 'bad'.repeat(20),
        'X-Signature-Timestamp': '1700000000',
      }),
    );

    expect(response.status).toBe(401);
    expect(issueSetupToken).not.toHaveBeenCalled();
  });

  test('a command other than /setup still reaches the unimplemented gap', async () => {
    const response = await POST(
      signedRequest({
        type: APPLICATION_COMMAND_INTERACTION_TYPE,
        guild_id: GUILD_ID,
        data: { id: '1539212298600718419', name: 'Clip', type: 3 },
        member: { user: { id: USER_ID }, permissions: MANAGE_GUILD_ONLY },
      }),
    );

    expect(response.status).toBe(501);
    expect(issueSetupToken).not.toHaveBeenCalled();
  });
});
