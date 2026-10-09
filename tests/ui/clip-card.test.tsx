// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ClipCard } from '@/components/archive/ClipCard';

// See tests/ui/primitives.test.tsx: no `test.globals`, so cleanup is manual.
afterEach(cleanup);

const base = {
  authorUserId: '111',
  sourceChannelLabel: 'general',
  clippedAt: '2026-10-09T12:04:00.000Z',
  originalUrl: 'https://discord.com/channels/1/2/3',
};
const meta = {
  sourceMessageId: '3',
  authorName: 'ori',
  originalAt: '2026-10-01T00:00:00.000Z',
  original: 'available' as const,
};

test('loading shows the literal loading line', () => {
  render(<ClipCard {...base} content={{ state: 'loading' }} />);
  expect(screen.getByText('Discord에서 내용을 불러오는 중…')).toBeInTheDocument();
});

test('ready renders the hierarchy, code, attachments, the reply line, and the original link', () => {
  render(
    <ClipCard
      {...base}
      content={{
        ...meta,
        state: 'ready',
        body: [
          { kind: 'text', text: '<script>alert(1)</script> hi' },
          { kind: 'code', text: 'const a = 1;' },
        ],
        attachments: [
          { filename: 'a.png', url: 'https://cdn.discordapp.com/a.png', isImage: true },
          { filename: 'b.txt', url: 'https://cdn.discordapp.com/b.txt', isImage: false },
        ],
        embeds: [{ title: 'T', description: 'D', url: 'https://example.com' }],
        replyToAuthorName: 'parent',
      }}
    />,
  );
  expect(screen.getByText('ori')).toBeInTheDocument();
  expect(screen.getByText('#general')).toBeInTheDocument();
  expect(screen.getByText('2026-10-01 09:00')).toBeInTheDocument();
  expect(screen.getByText('<script>alert(1)</script> hi')).toBeInTheDocument(); // text, not markup
  expect(document.querySelector('script')).toBeNull();
  expect(screen.getByText('const a = 1;').tagName).toBe('CODE');
  expect(screen.getByText('답장 → @parent')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'a.png' })).toHaveAttribute('src', 'https://cdn.discordapp.com/a.png');
  expect(screen.getByRole('link', { name: 'b.txt' })).toHaveAttribute('href', 'https://cdn.discordapp.com/b.txt');
  expect(screen.getByRole('link', { name: 'T' })).toHaveAttribute('href', 'https://example.com');
  expect(screen.getByRole('link', { name: '원본 보기' })).toHaveAttribute('href', base.originalUrl);
  expect(screen.getByText('클립 2026-10-09')).toBeInTheDocument();
});

test('missing keeps the metadata under the 누락 tag and approved copy', () => {
  render(<ClipCard {...base} content={{ ...meta, state: 'missing' }} />);
  expect(screen.getByText('누락')).toBeInTheDocument();
  expect(screen.getByText('보관된 사본을 Discord에서 찾을 수 없습니다')).toBeInTheDocument();
  expect(screen.getByText('ori')).toBeInTheDocument();
});

test('an unavailable original replaces the link with the approved text', () => {
  render(<ClipCard {...base} content={{ ...meta, original: 'unavailable', state: 'missing' }} />);
  expect(screen.queryByRole('link', { name: '원본 보기' })).toBeNull();
  expect(screen.getByText('원본 메시지를 찾을 수 없습니다.')).toBeInTheDocument();
});

test('error rows separate access from transient, keep metadata, and offer retry', async () => {
  const onRetry = vi.fn();
  const { rerender } = render(
    <ClipCard {...base} content={{ ...meta, state: 'error', reason: 'access' }} onRetry={onRetry} />,
  );
  expect(
    screen.getByText('아카이브 채널에 접근할 수 없습니다. Discord에서 Clip의 채널 권한을 확인해 주세요.'),
  ).toBeInTheDocument();
  rerender(<ClipCard {...base} content={{ ...meta, state: 'error', reason: 'transient' }} onRetry={onRetry} />);
  expect(screen.getByText('보관된 내용을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(onRetry).toHaveBeenCalledOnce();
  expect(screen.getByText('ori')).toBeInTheDocument();
});

test('an unknown author shows the user id', () => {
  render(<ClipCard {...base} content={{ ...meta, authorName: null, state: 'missing' }} />);
  expect(screen.getByText('111')).toBeInTheDocument();
});

test('two attachments with the same URL both render without a key clash', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const same = { filename: 'dup.txt', url: 'https://cdn.discordapp.com/dup.txt', isImage: false };
  render(
    <ClipCard
      {...base}
      content={{ ...meta, state: 'ready', body: [], attachments: [same, same], embeds: [], replyToAuthorName: null }}
    />,
  );
  expect(screen.getAllByRole('link', { name: 'dup.txt' })).toHaveLength(2);
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});
