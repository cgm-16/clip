// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const { ArchiveScreen } = await import('@/app/admin/[guildId]/archive/ArchiveScreen');

// See tests/ui/primitives.test.tsx: no `test.globals`, so cleanup is manual.
afterEach(cleanup);

const items = ['m1', 'm2', 'm3'].map((id, index) => ({
  sourceMessageId: id,
  sourceChannelId: index === 2 ? 'c2' : 'c1',
  authorUserId: `u${index}`,
  clippedAt: '2026-10-09T12:04:00.000Z',
}));

const props = {
  guildId: 'g1',
  guildLabel: 'testa',
  items,
  total: 3,
  range: { start: 1, end: 3 },
  newerHref: null,
  olderHref: null,
  channelOptions: [
    { id: 'c1', label: 'general' },
    { id: 'c2', label: 'c2' },
  ],
  selectedChannel: null,
};

function ready(id: string) {
  return {
    sourceMessageId: id,
    state: 'ready',
    authorName: `name-${id}`,
    originalAt: '2026-10-01T00:00:00.000Z',
    original: 'available',
    body: [{ kind: 'text', text: `body-${id}` }],
    attachments: [],
    embeds: [],
    replyToAuthorName: null,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test('renders the shell with loading rows before content arrives, and fetches only this page', async () => {
  const pending = Promise.withResolvers<Response>();
  fetchMock.mockReturnValue(pending.promise);
  render(<ArchiveScreen {...props} />);
  expect(screen.getAllByText('Discord에서 내용을 불러오는 중…')).toHaveLength(3);
  expect(screen.getByText('3개')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/api/admin/guilds/g1/archive/content');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual({ sourceMessageIds: ['m1', 'm2', 'm3'] });
  pending.resolve(json({ items: items.map((item) => ready(item.sourceMessageId)) }));
  expect(await screen.findByText('body-m1')).toBeInTheDocument();
});

test('content replaces the skeletons and the list stops being busy', async () => {
  fetchMock.mockResolvedValue(json({ items: items.map((item) => ready(item.sourceMessageId)) }));
  const { container } = render(<ArchiveScreen {...props} />);
  expect(await screen.findByText('body-m3')).toBeInTheDocument();
  expect(container.querySelector('[aria-live="polite"]')).toHaveAttribute('aria-busy', 'false');
});

test('a 401 replaces the page with the session-expired screen', async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
  render(<ArchiveScreen {...props} />);
  expect(await screen.findByText('관리자 세션이 만료되었습니다')).toBeInTheDocument();
  expect(screen.queryByText('Discord에서 내용을 불러오는 중…')).toBeNull();
});

test('a failed load turns rows into retryable errors, and retry re-reads only that row', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
  render(<ArchiveScreen {...props} />);
  const retries = await screen.findAllByRole('button', { name: '다시 시도' });
  expect(retries).toHaveLength(3);
  expect(screen.getAllByText('보관된 내용을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')).toHaveLength(3);
  fetchMock.mockResolvedValueOnce(json({ items: [ready('m2')] }));
  await userEvent.click(retries[1]);
  expect(await screen.findByText('body-m2')).toBeInTheDocument();
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ sourceMessageIds: ['m2'] });
});

test('a network failure is a retryable error too', async () => {
  fetchMock.mockRejectedValue(new TypeError('offline'));
  render(<ArchiveScreen {...props} />);
  expect(await screen.findAllByRole('button', { name: '다시 시도' })).toHaveLength(3);
});

test('unmounting aborts the in-flight read', () => {
  fetchMock.mockReturnValue(new Promise(() => {}));
  const { unmount } = render(<ArchiveScreen {...props} />);
  const signal: AbortSignal = fetchMock.mock.calls[0][1].signal;
  expect(signal.aborted).toBe(false);
  unmount();
  expect(signal.aborted).toBe(true);
});

test('the channel filter navigates by URL, and 전체 clears it', async () => {
  fetchMock.mockReturnValue(new Promise(() => {}));
  render(<ArchiveScreen {...props} />);
  const select = screen.getByLabelText('채널');
  await userEvent.selectOptions(select, 'c2');
  expect(push).toHaveBeenLastCalledWith('/admin/g1/archive?channel=c2');
  await userEvent.selectOptions(select, '');
  expect(push).toHaveBeenLastCalledWith('/admin/g1/archive');
  expect(within(select).getByRole('option', { name: '#general' })).toBeInTheDocument();
});

test('pagination links exist only where there is a page to go to', () => {
  fetchMock.mockReturnValue(new Promise(() => {}));
  const { rerender } = render(<ArchiveScreen {...props} />);
  expect(screen.getByText('1–3 / 3')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '이전' })).toBeNull();
  expect(screen.getByText('이전')).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByText('다음')).toHaveAttribute('aria-disabled', 'true');
  rerender(<ArchiveScreen {...props} newerHref="/admin/g1/archive?after=1.a" olderHref="/admin/g1/archive?before=2.b" />);
  expect(screen.getByRole('link', { name: '이전' })).toHaveAttribute('href', '/admin/g1/archive?after=1.a');
  expect(screen.getByRole('link', { name: '다음' })).toHaveAttribute('href', '/admin/g1/archive?before=2.b');
});

test('empty states distinguish an empty archive from an empty filter', () => {
  const empty = { ...props, items: [], total: 0, range: null };
  const { rerender } = render(<ArchiveScreen {...empty} />);
  expect(screen.getByText('아직 보관된 메시지가 없습니다.')).toBeInTheDocument();
  rerender(<ArchiveScreen {...empty} selectedChannel="c2" />);
  expect(screen.getByText('이 채널에서 보관된 메시지가 없습니다.')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('the header tabs are links, with the archive marked current', () => {
  fetchMock.mockReturnValue(new Promise(() => {}));
  render(<ArchiveScreen {...props} />);
  expect(screen.getByRole('link', { name: '아카이브' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: '설정' })).toHaveAttribute('href', '/admin/g1/settings');
  expect(screen.getByText('testa')).toBeInTheDocument();
});

test('a row whose id is missing from the response becomes an error, not a stuck skeleton', async () => {
  fetchMock.mockResolvedValue(json({ items: [ready('m1')] }));
  render(<ArchiveScreen {...props} />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: '다시 시도' })).toHaveLength(2));
});
