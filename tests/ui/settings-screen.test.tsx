// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { SettingsScreen } from '@/app/admin/[guildId]/settings/SettingsScreen';

// See tests/ui/primitives.test.tsx: no `test.globals`, so cleanup is manual.
afterEach(cleanup);

const props = {
  guildId: 'g1',
  guildLabel: 'testa',
  archiveChannelLabel: 'clip-archive',
  archiveChannelMissing: false,
  allowedRoles: [{ id: 'r1', name: 'clip-test' }],
  clipCount: 3,
  saved: false,
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

async function openAndAcknowledge() {
  await userEvent.click(screen.getByRole('button', { name: 'Clip 데이터 삭제' }));
  await userEvent.click(
    screen.getByRole('checkbox', { name: '위 내용을 이해했으며 되돌릴 수 없다는 것을 알고 있습니다.' }),
  );
}

function confirmPanel() {
  return screen.getByRole('region', { name: 'Clip 데이터를 삭제하면' });
}

test('shows the current configuration and the edit link', () => {
  render(<SettingsScreen {...props} />);
  expect(screen.getByText('현재 설정')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'testa' })).toBeInTheDocument();
  expect(screen.getByText('#clip-archive')).toBeInTheDocument();
  expect(screen.getByText('@clip-test')).toBeInTheDocument();
  expect(screen.getByText('3개')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '설정 변경' })).toHaveAttribute('href', '/admin/g1/setup');
  expect(screen.getByRole('link', { name: '설정' })).toHaveAttribute('aria-current', 'page');
});

test('deletion is two steps with consequence copy, and the second step needs the acknowledgement', async () => {
  render(<SettingsScreen {...props} />);
  expect(screen.queryByText('Clip 데이터를 삭제하면')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Clip 데이터 삭제' }));
  const panel = confirmPanel();
  expect(within(panel).getByText('아카이브 위치·허용 역할 설정')).toBeInTheDocument();
  expect(within(panel).getByText('보관 기록과 누가 언제 클립했는지에 대한 정보')).toBeInTheDocument();
  expect(within(panel).getByText('Discord의 #clip-archive 채널과 그 안의 모든 메시지')).toBeInTheDocument();
  expect(within(panel).getByText('원본 채널의 메시지 (영향 없음)')).toBeInTheDocument();
  expect(within(panel).getByText(/보관 기록과 삭제 차단 기록이 사라집니다/)).toBeInTheDocument();
  const confirm = within(panel).getByRole('button', { name: '삭제 실행' });
  expect(confirm).toBeDisabled();
  await userEvent.click(
    within(panel).getByRole('checkbox', { name: '위 내용을 이해했으며 되돌릴 수 없다는 것을 알고 있습니다.' }),
  );
  expect(confirm).toBeEnabled();
});

test('a confirmed deletion posts the acknowledgement and shows completion with /setup recovery', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
  render(<SettingsScreen {...props} />);
  await openAndAcknowledge();
  await userEvent.click(screen.getByRole('button', { name: '삭제 실행' }));
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/admin/guilds/g1/delete-data',
    expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acknowledged: true }),
    }),
  );
  expect(await screen.findByText(/이 서버의 Clip 데이터를 삭제했습니다/)).toBeInTheDocument();
  expect(screen.getByText('/setup')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Clip 데이터 삭제' })).toBeNull();
});

test('a failed deletion keeps the panel and lets the admin retry', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
  render(<SettingsScreen {...props} />);
  await openAndAcknowledge();
  await userEvent.click(screen.getByRole('button', { name: '삭제 실행' }));
  expect(await screen.findByText('Clip 데이터를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '삭제 실행' })).toBeEnabled();
});

test('a network failure is a failed deletion, not a success', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('offline'));
  render(<SettingsScreen {...props} />);
  await openAndAcknowledge();
  await userEvent.click(screen.getByRole('button', { name: '삭제 실행' }));
  expect(await screen.findByText('Clip 데이터를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.')).toBeInTheDocument();
});

test('a 401 replaces the page with the session-expired screen', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
  render(<SettingsScreen {...props} />);
  await openAndAcknowledge();
  await userEvent.click(screen.getByRole('button', { name: '삭제 실행' }));
  expect(await screen.findByText('관리자 세션이 만료되었습니다')).toBeInTheDocument();
});

test('취소 closes the confirm panel and clears the acknowledgement', async () => {
  render(<SettingsScreen {...props} />);
  await openAndAcknowledge();
  await userEvent.click(within(confirmPanel()).getByRole('button', { name: '취소' }));
  expect(screen.queryByText('Clip 데이터를 삭제하면')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Clip 데이터 삭제' }));
  expect(within(confirmPanel()).getByRole('button', { name: '삭제 실행' })).toBeDisabled();
});

test('a saved edit shows the toast in a live region', () => {
  render(<SettingsScreen {...props} saved />);
  const toast = screen.getByText('설정을 저장했습니다.');
  expect(toast.closest('[aria-live="polite"]')).not.toBeNull();
});

test('a deleted archive channel is called out with 누락 (#58)', () => {
  render(<SettingsScreen {...props} archiveChannelMissing />);
  expect(screen.getByText('누락')).toBeInTheDocument();
  expect(
    screen.getByText('설정된 아카이브 채널이 Discord에 없습니다. 다른 채널을 선택하거나 새로 만들어 주세요.'),
  ).toBeInTheDocument();
});
