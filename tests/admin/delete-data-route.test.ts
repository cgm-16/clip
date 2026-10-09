import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { authenticateAdminRequest, deleteGuildData } = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  deleteGuildData: vi.fn(),
}));
vi.mock('@/lib/admin/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/auth')>()),
  authenticateAdminRequest,
}));
vi.mock('@/lib/admin/guild-data', () => ({ deleteGuildData }));

const { POST } = await import('@/app/api/admin/guilds/[guildId]/delete-data/route');
const context = { params: Promise.resolve({ guildId: 'g1' }) };

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('https://clipendpoint.cc/api/admin/guilds/g1/delete-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'clip_admin_session=s', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST delete-data', () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    // rejectUnsafeMutation parses the whole Env, so every variable needs a value.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');
    vi.stubEnv('DATABASE_URL', 'postgresql://x');
    vi.stubEnv('DISCORD_APPLICATION_ID', '1');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', 't');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    vi.stubGlobal('fetch', fetchSpy);
    authenticateAdminRequest.mockResolvedValue({ identity: { guildId: 'g1', userId: 'u' }, sessionTokenHash: 'h' });
  });

  test('deletes, clears the session cookie, and calls Discord zero times', async () => {
    deleteGuildData.mockResolvedValue({ kind: 'DELETED' });
    const response = await POST(post({ acknowledged: true }), context);
    expect(response.status).toBe(200);
    expect(deleteGuildData).toHaveBeenCalledWith('g1', 'h');
    const cookie = response.headers.get('Set-Cookie') ?? '';
    expect(cookie).toMatch(/clip_admin_session=;/);
    expect(cookie).toMatch(/Max-Age=0/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('requires the explicit acknowledgement', async () => {
    expect((await POST(post({ acknowledged: false }), context)).status).toBe(400);
    expect((await POST(post({}), context)).status).toBe(400);
    expect(deleteGuildData).not.toHaveBeenCalled();
  });

  test('refuses cross-origin and non-JSON requests before authenticating', async () => {
    expect((await POST(post({ acknowledged: true }, { Origin: 'https://evil.example' }), context)).status).toBe(403);
    expect((await POST(post({ acknowledged: true }, { 'Content-Type': 'text/plain' }), context)).status).toBe(415);
    expect(authenticateAdminRequest).not.toHaveBeenCalled();
  });

  test('401 without a session for this guild, and when revoked under the lock', async () => {
    authenticateAdminRequest.mockResolvedValueOnce(null);
    expect((await POST(post({ acknowledged: true }), context)).status).toBe(401);
    deleteGuildData.mockResolvedValue({ kind: 'SESSION_REVOKED' });
    expect((await POST(post({ acknowledged: true }), context)).status).toBe(401);
  });

  test('a failed delete is a 500 and does not clear the cookie', async () => {
    deleteGuildData.mockRejectedValue(new Error('db down'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await POST(post({ acknowledged: true }), context);
    expect(response.status).toBe(500);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('admin.delete-data-failed'));
    log.mockRestore();
  });
});
