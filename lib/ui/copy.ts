/**
 * Korean copy for the P0 web UI (screens A–E), quoted verbatim from
 * `docs/06_DESIGN_HANDOFF.md` § "Screens". That document is final: an entry
 * here is copied from it character for character — punctuation, `·`
 * separators, `…`, `—` and the en dash in the pagination range included — and
 * is never paraphrased, shortened or written fresh. A screen that needs a
 * sentence the handoff does not supply gets the gap reported, not invented.
 *
 * Keys name the *condition* the copy answers, not the screen it happens to sit
 * on, because the same condition can surface in more than one place. The
 * grouping is by concern (setup, archive, deletion), not by screen letter.
 *
 * `{...}` markers are interpolation points, never baked-in values. Each is
 * commented with what fills it. Discord-side interaction copy is not here —
 * that table lives in `lib/discord/copy.ts`.
 */
export const WEB_COPY = {
  /**
   * The leading text tags that carry state. Every state is announced by one of
   * these, never by colour alone.
   */
  tags: {
    note: 'NOTE',
    ok: 'OK',
    confirm: '확인',
    error: '오류',
    missing: '누락',
  },

  /** Screen A — the setup link is expired, used, or unknown. */
  expiredSetupLink: {
    title: '설정 링크가 만료되었습니다',
    explanation:
      '관리자 설정 링크는 한 번만 사용할 수 있고, 발급 후 15분이 지나면 만료됩니다. 이미 사용된 링크일 수도 있습니다.',
    /** NOTE callout — how to get a fresh link. */
    recovery: 'Discord 서버에서 /setup 을 다시 실행하면 새 링크를 받을 수 있습니다.',
    /** Footnote below the divider — reassurance for an already-configured guild. */
    archiveStillWorks: '이미 설정을 마친 서버라면 이 링크 없이도 아카이브는 정상 동작합니다.',
  },

  /** Screen B — first-run configuration. */
  setup: {
    destinationLegend: '보관 위치',
    /** The recommended option: Clip creates the channel itself. */
    destinationCreateLabel: '비공개 아카이브 채널 새로 만들기 — 권장',
    destinationCreateDescription:
      'Clip이 #clip-archive 를 만들고, 설정된 역할만 볼 수 있도록 권한을 지정합니다. 생성이 끝나면 채널 관리 권한은 회수해도 됩니다.',
    destinationExistingLabel: '기존 채널 사용',
    /** Shown once the existing-channel option is chosen. */
    destinationExistingWarning:
      '기존 채널을 쓰면 해당 채널을 볼 수 있는 모든 멤버가 아카이브를 볼 수 있습니다.',
    /** Existing channel chosen but none selected — blocks save. */
    destinationChannelRequired: '채널을 선택해야 저장할 수 있습니다.',

    rolesLegend: '클립 허용 역할',
    /** Inline placeholder inside the chip field. */
    rolesPlaceholder: '역할 추가…',
    /** NOTE callout — an empty role list is valid. */
    rolesNote:
      '서버 관리자는 이 목록과 무관하게 항상 클립할 수 있습니다. 역할을 비워 두면 관리자만 클립합니다.',

    consequencesHeading: '이 설정으로 일어나는 일',
    consequenceClipping: '설정된 역할의 멤버가 이 서버의 메시지를 아카이브에 보존할 수 있습니다.',
    consequenceStorage:
      '보존된 메시지 본문은 Discord 아카이브 채널에 남고, Clip은 식별자와 운영 정보만 저장합니다.',
    consequenceAuthorRemoval: '작성자는 자신의 메시지를 아카이브에서 직접 제거할 수 있습니다.',

    save: '설정 저장',
    cancel: '취소',
    /** Toast on an edit that succeeds; a first run goes to Screen C instead. */
    saved: '설정을 저장했습니다.',
  },

  /** Screen C — configuration accepted. */
  setupComplete: {
    /** State tag above the title. */
    readyTag: 'READY',
    title: '설정을 마쳤습니다',

    archiveChannelKey: '아카이브 채널',
    allowedRolesKey: '허용 역할',
    adminsKey: '관리자',
    /** The admin row's value: admins are exempt from the role list. */
    adminsValue: '설정과 무관하게 항상 허용',
    clipCountKey: '보관된 메시지',

    usageHeading: '사용법',
    /** The `Clip` token renders as a bordered mono chip. */
    usageSteps: '메시지 우클릭 → 앱 → Clip',

    /** OK callout, shown only when Clip created the channel itself. */
    manageChannelNoLongerNeeded:
      '채널을 자동 생성했으므로 일상 운영에는 채널 관리 권한이 더 이상 필요하지 않습니다.',

    openArchive: '아카이브 열기',
    reviewSettings: '설정 다시 보기',
  },

  /** Screen D — the read-only archive list. */
  archive: {
    /** The only two navigation targets in P0. */
    archiveTab: '아카이브',
    settingsTab: '설정',

    channelFilterLabel: '채널',
    /** Default channel-filter option: no channel restriction. */
    channelFilterAll: '전체',
    sortNewestFirst: '최신순',

    /** Row body still being fetched from Discord. */
    loadingFromDiscord: 'Discord에서 내용을 불러오는 중…',

    /** The Discord copy is gone; the archive record itself survives. */
    missingCopyTitle: '보관된 사본을 Discord에서 찾을 수 없습니다',
    missingCopyExplanation:
      '아카이브 채널의 메시지가 삭제된 것 같습니다. 보관 기록(작성자·채널·시각)은 남아 있습니다.',

    previousPage: '이전',
    nextPage: '다음',
  },

  /** The clip card, shared by every list row. */
  clipCard: {
    /** Prefix on the reply-provenance line, trailing space intended. */
    replyPrefix: '답장 → ',
  },

  /** Screen E — current configuration and the destructive action. */
  deleteData: {
    currentSettingsLabel: '현재 설정',
    editSettings: '설정 변경',

    dangerZoneLegend: '위험 구역',
    dangerZoneExplanation:
      'Clip이 저장한 설정·권한·보관 기록을 이 서버에서 모두 지웁니다. Discord 아카이브 채널과 그 안의 메시지는 삭제되지 않습니다.',
    /** Step 1: opens the confirm panel. Never deletes on its own. */
    startDeletion: 'Clip 데이터 삭제',

    confirmTitle: 'Clip 데이터를 삭제하면',
    /** Marks on each consequence row. */
    removedMark: '삭제',
    keptMark: '유지',
    removedConfiguration: '아카이브 위치·허용 역할 설정',
    removedClipRecords: '보관 기록과 누가 언제 클립했는지에 대한 정보',
    keptSourceMessages: '원본 채널의 메시지 (영향 없음)',

    acknowledgement: '위 내용을 이해했으며 되돌릴 수 없다는 것을 알고 있습니다.',
    /** Step 2: enabled only once the acknowledgement is checked. */
    confirmDeletion: '삭제 실행',
    cancel: '취소',
  },
} as const;

/**
 * Copy that carries a runtime value. Kept apart from `WEB_COPY` because the
 * handoff writes these with a concrete example (`47개`, `1–5 / 47`,
 * `#clip-archive`, `클립 {date}`); the surrounding characters are quoted
 * verbatim and only the value is replaced.
 */
export const WEB_COPY_TEMPLATES = {
  /** `{count}` is the number of clips. Handoff example: `47개`. */
  clipCount: '{count}개',
  /**
   * Pagination range. `{start}`/`{end}` are the 1-based bounds of the page and
   * `{total}` the full count; the separator is an en dash. Handoff: `1–5 / 47`.
   */
  pageRange: '{start}–{end} / {total}',
  /** Clip card footer. `{date}` is the date the message was clipped. */
  clippedOn: '클립 {date}',
  /**
   * Screen B identity bar, right side. `{handle}` is the admin's Discord
   * handle without its `@`. Handoff example: `관리자 · @handle`.
   */
  adminIdentity: '관리자 · @{handle}',
  /**
   * Screen E, the surviving-data row. `{channel}` is the archive channel name
   * without its `#`. Handoff example: `Discord의 #clip-archive 채널과 그 안의 모든 메시지`.
   */
  keptArchiveChannel: 'Discord의 #{channel} 채널과 그 안의 모든 메시지',
} as const;

/**
 * Copy with no handoff source at all — `docs/06_DESIGN_HANDOFF.md` does not
 * specify a string for the condition, and none is invented at implementation
 * time (`CLAUDE.md` rule 9). Kept apart from `WEB_COPY` so `tests/ui/copy.test.ts`'s
 * "quotes every entry verbatim from the handoff document" check — which walks
 * `WEB_COPY` looking for drift from `docs/06_DESIGN_HANDOFF.md` — does not
 * have to special-case entries that were never quoted from it in the first
 * place; that invariant is about anti-drift for quoted copy and does not
 * apply here. Every entry must record who authored it and when.
 */
export const WEB_COPY_AUTHORED = {
  /**
   * Screen B save failure — expired session, channel gone, Discord refusing
   * channel creation, a 5xx, etc. The handoff has no string for this
   * condition (recorded as a gap in `docs/DESIGN_RATIONALE_APPEND.md`
   * §10.8-3). Authored by Ori on 2026-08-20; see that same file's §11.5 for
   * the record. The `/setup` token renders as a bordered mono chip, the same
   * treatment `WEB_COPY.expiredSetupLink.recovery` gives it.
   */
  saveFailed: '정보를 저장할 수 없습니다. 다시 시도하거나, /setup으로 새로운 링크를 발급해 주세요.',
} as const;
