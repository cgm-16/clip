// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { WEB_COPY, WEB_COPY_AUTHORED } from '@/lib/ui/copy';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

const { AdminSetupEdit } = await import('@/app/admin/[guildId]/setup/AdminSetupEdit');

// See tests/ui/primitives.test.tsx: no `test.globals`, so cleanup is manual.
afterEach(cleanup);

const CHANNELS = [
  { id: '111', name: 'clip-archive', type: 0 },
  { id: '222', name: 'general', type: 0 },
];

function setupDataBody(overrides: Record<string, unknown> = {}) {
  return {
    guildId: 'g1',
    guildName: 'Test guild',
    adminHandle: 'admin',
    channels: CHANNELS,
    roles: [
      { id: 'g1', name: '@everyone', selectable: false },
      { id: 'm', name: 'moderator', selectable: true },
    ],
    config: { archiveChannelId: '111', allowedRoleIds: ['m'] },
    archiveChannelMissing: false,
    ...overrides,
  };
}

const SAVED = {
  archiveChannelId: '111',
  archiveChannelName: 'clip-archive',
  autoCreated: false,
  clipCount: 2,
  allowedRoles: [{ id: 'm', name: 'moderator' }],
};

function stubFetch(save: () => Response, data: () => Response = () => Response.json(setupDataBody())) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/setup/data')) return data();
    if (url.endsWith('/setup/save')) return save();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('opens prefilled and maps a 422 MISSING_PERMISSIONS body to the refusal', async () => {
  const user = userEvent.setup();
  const fetchMock = stubFetch(() =>
    Response.json({ reason: 'MISSING_PERMISSIONS', missingPermissions: ['SEND_MESSAGES'] }, { status: 422 }),
  );
  render(<AdminSetupEdit guildId="g1" />);

  expect(await screen.findByRole('button', { name: 'moderator', pressed: true })).toBeInTheDocument();
  expect(screen.getByText('Test guild')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

  expect(await screen.findByText('SEND_MESSAGES')).toBeInTheDocument();
  const saveCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/setup/save'));
  expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
    destination: 'existing',
    channelId: '111',
    allowedRoleIds: ['m'],
  });
  expect(navigation.push).not.toHaveBeenCalled();
});

test('maps a 409 to the live-Clips explanation with a link to the archive (#59)', async () => {
  const user = userEvent.setup();
  stubFetch(() => Response.json({ reason: 'LIVE_CLIPS' }, { status: 409 }));
  render(<AdminSetupEdit guildId="g1" />);
  await user.click(await screen.findByRole('button', { name: WEB_COPY.setup.save }));

  expect(await screen.findByText(WEB_COPY_AUTHORED.destinationChangeBlocked)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: WEB_COPY.setupComplete.openArchive })).toHaveAttribute(
    'href',
    '/admin/g1/archive',
  );
});

test('a successful save returns to Screen E with the saved toast flag', async () => {
  const user = userEvent.setup();
  stubFetch(() => Response.json(SAVED));
  render(<AdminSetupEdit guildId="g1" />);
  await user.click(await screen.findByRole('button', { name: WEB_COPY.setup.save }));
  await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/admin/g1/settings?saved=1'));
});

test('취소 returns to Screen E without saving', async () => {
  const user = userEvent.setup();
  const fetchMock = stubFetch(() => Response.json(SAVED));
  render(<AdminSetupEdit guildId="g1" />);
  await user.click(await screen.findByRole('button', { name: WEB_COPY.setup.cancel }));
  expect(navigation.push).toHaveBeenCalledWith('/admin/g1/settings');
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/setup/save'))).toBe(false);
});

test('a lost session renders the session-expired screen', async () => {
  stubFetch(
    () => Response.json(SAVED),
    () => new Response(null, { status: 401 }),
  );
  render(<AdminSetupEdit guildId="g1" />);
  expect(await screen.findByText(WEB_COPY_AUTHORED.adminSessionExpiredTitle)).toBeInTheDocument();
});

test('a deleted archive channel is flagged on the form (#58)', async () => {
  stubFetch(
    () => Response.json(SAVED),
    () => Response.json(setupDataBody({ config: { archiveChannelId: 'gone', allowedRoleIds: [] }, archiveChannelMissing: true })),
  );
  render(<AdminSetupEdit guildId="g1" />);
  expect(await screen.findByText(WEB_COPY_AUTHORED.archiveChannelMissing)).toBeInTheDocument();
});

test('a save refused for an expired session shows the session-expired screen, not a save failure', async () => {
  const user = userEvent.setup();
  stubFetch(() => new Response(null, { status: 401 }));
  render(<AdminSetupEdit guildId="g1" />);
  await user.click(await screen.findByRole('button', { name: WEB_COPY.setup.save }));
  expect(await screen.findByText(WEB_COPY_AUTHORED.adminSessionExpiredTitle)).toBeInTheDocument();
});
