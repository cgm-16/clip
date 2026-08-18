import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { POST } from '@/app/api/discord/interactions/route';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

function signBody(body: string, timestamp: string): string {
  return sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
}

function request(body: string, headers: Record<string, string>): Request {
  return new Request('https://clipendpoint.cc/api/discord/interactions', {
    method: 'POST',
    headers,
    body,
  });
}

describe('POST /api/discord/interactions', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgresql://clip:pw@localhost:5432/clip');
    vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
    vi.stubEnv('DISCORD_PUBLIC_KEY', publicKeyHex);
    vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('rejects a request with no signature headers', async () => {
    const response = await POST(request(JSON.stringify({ type: 1 }), {}));

    expect(response.status).toBe(401);
  });

  test('rejects a request with a bad signature', async () => {
    const response = await POST(
      request(JSON.stringify({ type: 1 }), {
        'X-Signature-Ed25519': 'bad'.repeat(20),
        'X-Signature-Timestamp': '1700000000',
      }),
    );

    expect(response.status).toBe(401);
  });

  test('responds to a validly signed PING with PONG', async () => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1700000000';
    const signature = signBody(body, timestamp);

    const response = await POST(
      request(body, {
        'X-Signature-Ed25519': signature,
        'X-Signature-Timestamp': timestamp,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  test('responds to a validly signed non-PING interaction with 501', async () => {
    // Other interaction types (application command, message component, ...)
    // are later waves' work; a signed request for one should reach that gap
    // deliberately rather than be misrouted into PONG or a 401.
    const body = JSON.stringify({ type: 2 });
    const timestamp = '1700000000';
    const signature = signBody(body, timestamp);

    const response = await POST(
      request(body, {
        'X-Signature-Ed25519': signature,
        'X-Signature-Timestamp': timestamp,
      }),
    );

    expect(response.status).toBe(501);
  });
});
