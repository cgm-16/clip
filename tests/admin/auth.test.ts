import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { authenticateAdminSession, cookieGet } = vi.hoisted(() => ({
  authenticateAdminSession: vi.fn(),
  cookieGet: vi.fn(),
}));
vi.mock('@/lib/admin-session/service', () => ({
  authenticateAdminSession,
  sessionTokenHash: (token: string) => `hash:${token}`,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));

const { authenticateAdminRequest, authenticateAdminPage, rejectUnsafeMutation } = await import('@/lib/admin/auth');

function request(headers: Record<string, string> = {}) {
  return new NextRequest('https://clipendpoint.cc/api/admin/guilds/g1/x', { method: 'POST', headers });
}

describe('admin auth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');
    vi.stubEnv('DATABASE_URL', 'postgresql://x');
    vi.stubEnv('DISCORD_APPLICATION_ID', '1');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', 't');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
  });

  test('no cookie is unauthenticated', async () => {
    expect(await authenticateAdminRequest(request(), 'g1')).toBeNull();
    expect(authenticateAdminSession).not.toHaveBeenCalled();
  });

  test('a live session for another guild is treated as no session', async () => {
    authenticateAdminSession.mockResolvedValue({ guildId: 'g2', userId: 'u' });
    expect(await authenticateAdminRequest(request({ Cookie: 'clip_admin_session=s' }), 'g1')).toBeNull();
  });

  test('a live session for this guild returns identity and hash', async () => {
    authenticateAdminSession.mockResolvedValue({ guildId: 'g1', userId: 'u' });
    expect(await authenticateAdminRequest(request({ Cookie: 'clip_admin_session=s' }), 'g1')).toEqual({
      identity: { guildId: 'g1', userId: 'u' },
      sessionTokenHash: 'hash:s',
    });
  });

  test('pages read the cookie through next/headers', async () => {
    cookieGet.mockReturnValue({ value: 's' });
    authenticateAdminSession.mockResolvedValue({ guildId: 'g1', userId: 'u' });
    expect((await authenticateAdminPage('g1'))?.identity.guildId).toBe('g1');
    expect(await authenticateAdminPage('g2')).toBeNull();
  });

  test('mutations need a same-origin JSON request', () => {
    expect(
      rejectUnsafeMutation(request({ Origin: 'https://evil.example', 'Content-Type': 'application/json' }))?.status,
    ).toBe(403);
    expect(rejectUnsafeMutation(request({ 'Content-Type': 'text/plain' }))?.status).toBe(415);
    expect(rejectUnsafeMutation(request({ 'Content-Type': 'application/json; charset=utf-8' }))).toBeNull();
  });
});
