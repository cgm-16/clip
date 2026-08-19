import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { WEB_COPY, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';

/**
 * The handoff is the authority. These tests read it at run time and compare
 * against it, so a string that drifts — including an invisible drift like a
 * middle dot swapped for an interpunct lookalike, or an em dash for an en
 * dash — fails here rather than shipping.
 */
const HANDOFF = readFileSync(
  fileURLToPath(new URL('../../docs/06_DESIGN_HANDOFF.md', import.meta.url)),
  'utf8',
);

type CopyNode = string | { readonly [key: string]: CopyNode };

function flatten(node: CopyNode, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  return Object.entries(node).flatMap(([key, value]) =>
    flatten(value, path ? `${path}.${key}` : key),
  );
}

const entries = flatten(WEB_COPY);

describe('web UI copy', () => {
  it('covers every screen the handoff specifies', () => {
    // A guard against the table quietly losing a screen: each group must exist
    // and carry entries.
    for (const group of [
      'tags',
      'expiredSetupLink',
      'setup',
      'setupComplete',
      'archive',
      'clipCard',
      'deleteData',
    ] as const) {
      expect(Object.keys(WEB_COPY[group]).length).toBeGreaterThan(0);
    }
    expect(entries.length).toBeGreaterThan(40);
  });

  it('has no empty entry', () => {
    for (const [path, value] of entries) {
      expect(value, path).not.toBe('');
      expect(value.trim(), path).not.toBe('');
    }
    for (const [path, value] of Object.entries(WEB_COPY_TEMPLATES)) {
      expect(value, path).not.toBe('');
    }
  });

  it('quotes every entry verbatim from the handoff document', () => {
    const missing = entries.filter(([, value]) => !HANDOFF.includes(value));
    expect(missing).toEqual([]);
  });

  it('titles the expired setup link exactly as the handoff does', () => {
    expect(WEB_COPY.expiredSetupLink.title).toBe('설정 링크가 만료되었습니다');
  });

  it('reproduces the handoff sentences byte for byte', () => {
    // Copied out of docs/06_DESIGN_HANDOFF.md, not out of lib/ui/copy.ts.
    expect(WEB_COPY.expiredSetupLink.explanation).toBe(
      '관리자 설정 링크는 한 번만 사용할 수 있고, 발급 후 15분이 지나면 만료됩니다. 이미 사용된 링크일 수도 있습니다.',
    );
    expect(WEB_COPY.setup.destinationCreateLabel).toBe(
      '비공개 아카이브 채널 새로 만들기 — 권장',
    );
    expect(WEB_COPY.setup.rolesNote).toBe(
      '서버 관리자는 이 목록과 무관하게 항상 클립할 수 있습니다. 역할을 비워 두면 관리자만 클립합니다.',
    );
    expect(WEB_COPY.setupComplete.usageSteps).toBe('메시지 우클릭 → 앱 → Clip');
    expect(WEB_COPY.archive.loadingFromDiscord).toBe('Discord에서 내용을 불러오는 중…');
    expect(WEB_COPY.archive.missingCopyTitle).toBe(
      '보관된 사본을 Discord에서 찾을 수 없습니다',
    );
    expect(WEB_COPY.archive.missingCopyExplanation).toBe(
      '아카이브 채널의 메시지가 삭제된 것 같습니다. 보관 기록(작성자·채널·시각)은 남아 있습니다.',
    );
    expect(WEB_COPY.deleteData.dangerZoneExplanation).toBe(
      'Clip이 저장한 설정·권한·보관 기록을 이 서버에서 모두 지웁니다. Discord 아카이브 채널과 그 안의 메시지는 삭제되지 않습니다.',
    );
    expect(WEB_COPY.deleteData.acknowledgement).toBe(
      '위 내용을 이해했으며 되돌릴 수 없다는 것을 알고 있습니다.',
    );
  });

  it('uses the exact separator characters the handoff uses', () => {
    // Homoglyphs survive an eyeball review; code points do not.
    expect(WEB_COPY.archive.missingCopyExplanation).toContain('·'); // MIDDLE DOT
    expect(WEB_COPY.deleteData.removedConfiguration).toContain('·');
    expect(WEB_COPY.setup.destinationCreateLabel).toContain('—'); // EM DASH
    expect(WEB_COPY.setup.rolesPlaceholder).toContain('…'); // HORIZONTAL ELLIPSIS
    expect(WEB_COPY.archive.loadingFromDiscord).toContain('…');
    expect(WEB_COPY.setupComplete.usageSteps).toContain('→'); // RIGHTWARDS ARROW
    expect(WEB_COPY.clipCard.replyPrefix).toBe('답장 → ');
    expect(WEB_COPY_TEMPLATES.pageRange).toContain('–'); // EN DASH
    expect(WEB_COPY_TEMPLATES.adminIdentity).toContain('·');
  });

  it('carries the state tags the design rules require', () => {
    expect(WEB_COPY.tags).toEqual({
      note: 'NOTE',
      ok: 'OK',
      confirm: '확인',
      error: '오류',
      missing: '누락',
    });
  });

  it('renders each template into the handoff literal it was quoted from', () => {
    const fill = (template: string, values: Record<string, string>) =>
      template.replace(/\{(\w+)\}/g, (_, key: string) => values[key]);

    // The right-hand sides are the handoff's own worked examples.
    expect(fill(WEB_COPY_TEMPLATES.clipCount, { count: '47' })).toBe('47개');
    expect(
      fill(WEB_COPY_TEMPLATES.pageRange, { start: '1', end: '5', total: '47' }),
    ).toBe('1–5 / 47');
    expect(fill(WEB_COPY_TEMPLATES.adminIdentity, { handle: 'handle' })).toBe(
      '관리자 · @handle',
    );
    expect(
      fill(WEB_COPY_TEMPLATES.keptArchiveChannel, { channel: 'clip-archive' }),
    ).toBe('Discord의 #clip-archive 채널과 그 안의 모든 메시지');

    for (const rendered of [
      '47개',
      '1–5 / 47',
      '관리자 · @handle',
      'Discord의 #clip-archive 채널과 그 안의 모든 메시지',
      WEB_COPY_TEMPLATES.clippedOn, // the handoff writes `클립 {date}` literally
    ]) {
      expect(HANDOFF).toContain(rendered);
    }
  });

  it('leaves Discord-side interaction copy to lib/discord/copy.ts', () => {
    // Duplicating that table here would give two sources for one string.
    for (const [, value] of entries) {
      expect(value).not.toContain('✓ 보관했습니다');
      expect(value).not.toContain('이미 보관된 메시지입니다');
    }
  });
});
