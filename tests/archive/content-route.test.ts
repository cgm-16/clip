import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { authenticateAdminRequest, loadArchiveContent } = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  loadArchiveContent: vi.fn(),
}));
vi.mock('@/lib/admin/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/auth')>()),
  authenticateAdminRequest,
}));
vi.mock('@/lib/archive/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/archive/content')>()),
  loadArchiveContent,
}));

const { POST } = await import('@/app/api/admin/guilds/[guildId]/archive/content/route');
const context = { params: Promise.resolve({ guildId: 'g1' }) };

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('https://clipendpoint.cc/api/admin/guilds/g1/archive/content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'clip_admin_session=s', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST archive/content', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // rejectUnsafeMutation parses the whole Env, so every variable needs a value.
    vi.stubEnv('PUBLIC_BASE_URL', 'https://clipendpoint.cc');
    vi.stubEnv('DATABASE_URL', 'postgresql://x');
    vi.stubEnv('DISCORD_APPLICATION_ID', '1');
    vi.stubEnv('DISCORD_PUBLIC_KEY', 'a'.repeat(64));
    vi.stubEnv('DISCORD_BOT_TOKEN', 't');
    vi.stubEnv('ADMIN_SESSION_SECRET', 'x'.repeat(32));
    authenticateAdminRequest.mockResolvedValue({ identity: { guildId: 'g1', userId: 'u' }, sessionTokenHash: 'h' });
  });

  test('401 without a session for this guild', async () => {
    authenticateAdminRequest.mockResolvedValue(null);
    expect((await POST(post({ sourceMessageIds: ['m1'] }), context)).status).toBe(401);
    expect(loadArchiveContent).not.toHaveBeenCalled();
  });

  test('400 for a malformed body or a batch the loader refuses', async () => {
    expect((await POST(post({ ids: ['m1'] }), context)).status).toBe(400);
    expect((await POST(post({ sourceMessageIds: [] }), context)).status).toBe(400);
    loadArchiveContent.mockResolvedValue({ kind: 'INVALID' });
    expect((await POST(post({ sourceMessageIds: ['m1'] }), context)).status).toBe(400);
  });

  test('415 for a non-JSON request', async () => {
    expect((await POST(post({ sourceMessageIds: ['m1'] }, { 'Content-Type': 'text/plain' }), context)).status).toBe(415);
  });

  test('200 with private, no-store items; the guild comes from the route, not the body', async () => {
    loadArchiveContent.mockResolvedValue({ kind: 'OK', items: [{ sourceMessageId: 'm1', state: 'missing' }] });
    const response = await POST(post({ sourceMessageIds: ['m1'], guildId: 'evil' }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ items: [{ sourceMessageId: 'm1', state: 'missing' }] });
    expect(loadArchiveContent).toHaveBeenCalledWith(expect.objectContaining({ guildId: 'g1', sourceMessageIds: ['m1'] }));
  });
});
