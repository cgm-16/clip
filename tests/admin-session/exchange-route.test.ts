import { afterEach, describe, expect, test, vi } from 'vitest';
import { ADMIN_SESSION_COOKIE_NAME } from '@/lib/admin-session/tokens';

const exchangeSetupToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/admin-session/service', () => ({ exchangeSetupToken }));

const { POST } = await import('@/app/api/setup/exchange/route');

function postJson(body: unknown): Request {
  return new Request('https://clipendpoint.cc/api/setup/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/setup/exchange', () => {
  afterEach(() => {
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
});
