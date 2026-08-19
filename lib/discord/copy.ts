/**
 * Korean copy for Discord-side interaction responses, quoted verbatim from
 * `docs/06_DESIGN_HANDOFF.md` § "Discord-side copy". That table is final: an
 * entry here is copied from it, never paraphrased, and never written fresh.
 *
 * Keys name the *condition* the handoff table names, not the command that
 * hits it, because one condition serves every surface that reaches it.
 */
export const DISCORD_COPY = {
  // The handoff's `no permission` row. It is the only refusal copy the table
  // offers, so `/setup` reuses it even though the table phrases the refusal
  // in terms of archiving a message.
  noPermission: '이 서버에서 메시지를 보관할 권한이 없습니다',
  // The first-clip author DM (§11.1). `{guild}` and `{channel}` are literal
  // placeholders the sender substitutes; the handoff's template already
  // supplies the `#` before `{channel}`, so the substituted value is a plain
  // channel name, not a mention.
  firstArchivalDm:
    '회원님이 **{guild} / #{channel}** 에 남긴 메시지가 이 서버의 Clip 아카이브에 보관되었습니다.',
  firstArchivalDmViewOriginal: '원본 보기',
  firstArchivalDmRemoveFromArchive: '아카이브에서 제거',
} as const;
