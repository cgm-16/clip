import { afterEach, describe, expect, test, vi } from 'vitest';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';

const exchangeSetupToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/admin-session/service', () => ({ exchangeSetupToken }));

const { POST } = await import('@/app/api/setup/exchange/route');

const BASE_URL = 'https://clipendpoint.cc';

function postJson(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE_URL}/api/setup/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// Only the Origin-bearing paths reach parseEnv, so only they need a full env.
function stubEnv(): void {
  vi.stubEnv('DATABASE_URL', 'postgresql://clip:pw@localhost:5433/clip_dev');
  vi.stubEnv('DISCORD_APPLICATION_ID', '1539212298600718416');
  vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
  vi.stubEnv('DISCORD_BOT_TOKEN', 'bot-token-value');
  vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
  vi.stubEnv('PUBLIC_BASE_URL', BASE_URL);
}

describe('POST /api/setup/exchange', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  test('a valid token returns the session cookie and no body', async () => {
    exchangeSetupToken.mockResolvedValue({
      token: 'session-bearer',
      guildId: '1539212298600718416',
      userId: '1539212298600718417',
      expiresAt: new Date(),
    });

    const response = await POST(postJson({ token: 'setup-bearer' }));

    expect(response.status).toBe(204);
    expect(exchangeSetupToken).toHaveBeenCalledWith('setup-bearer');
    const cookie = response.headers.get('Set-Cookie');
    expect(cookie).toContain(`${ADMIN_SESSION_COOKIE_NAME}=session-bearer`);
    expect(cookie).toContain('HttpOnly');
  });

  test('a used, expired or unknown token is refused with one indistinguishable 401', async () => {
    exchangeSetupToken.mockResolvedValue(null);

    const response = await POST(postJson({ token: 'setup-bearer' }));

    expect(response.status).toBe(401);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(await response.text()).toBe('');
  });

  test('a malformed body is rejected without touching the token store', async () => {
    const badShape = await POST(postJson({ token: 42 }));
    expect(badShape.status).toBe(400);

    const notJson = await POST(
      new Request('https://clipendpoint.cc/api/setup/exchange', {
        method: 'POST',
        body: 'not json',
      }),
    );
    expect(notJson.status).toBe(400);

    expect(exchangeSetupToken).not.toHaveBeenCalled();
  });

  test('a cross-origin POST is refused and exchanges nothing', async () => {
    // request.json() ignores Content-Type, so a text/plain POST from any site
    // is a CORS simple request with no preflight, and SameSite=Lax does not
    // stop a cookie from being *set*. Without the Origin check this returns
    // 204 and plants the attacker's guild session in the admin's browser.
    stubEnv();

    const response = await POST(
      postJson({ token: 'setup-bearer' }, { Origin: 'https://evil.example' }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(exchangeSetupToken).not.toHaveBeenCalled();
  });

  test('a same-origin POST is still accepted', async () => {
    stubEnv();
    exchangeSetupToken.mockResolvedValue({
      token: 'session-bearer',
      guildId: '1539212298600718416',
      userId: '1539212298600718417',
      expiresAt: new Date(),
    });

    const response = await POST(postJson({ token: 'setup-bearer' }, { Origin: BASE_URL }));

    expect(response.status).toBe(204);
    expect(exchangeSetupToken).toHaveBeenCalledExactlyOnceWith('setup-bearer');
  });
});
