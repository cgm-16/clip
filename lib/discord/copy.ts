/**
 * Korean copy for Discord-side interaction responses, quoted verbatim from
 * `docs/06_DESIGN_HANDOFF.md` § "Discord-side copy". That table is final: an
 * entry here is copied from it, never paraphrased, and never written fresh.
 *
 * Keys name the *condition* the handoff table names, not the command that
 * hits it, because one condition serves every surface that reaches it.
 */
export const DISCORD_COPY = {
  // Clip: a brand-new archival, or this member's first preservation signal
  // on a message someone else already archived. Both end with the message
  // archived because of this invocation, so both read as success (spec §10.1
  // groups them as "successful normal actions").
  success: '✓ 보관했습니다',
  // Clip: this exact member already clipped this exact message before. Not
  // an error (§10.1) -- the outcome the member wanted is already true.
  duplicate: '이미 보관된 메시지입니다',
  // Unclip, and `Remove from Clip Archive`: the archive is gone (or this
  // member's signal is), reusing one row for both since the handoff table
  // has no separate "removed" condition and both describe the same fact
  // to the member -- the message is no longer archived.
  unclipped: '✓ 보관을 해제했습니다',
  // Unclip: this member has no preservation signal on this message to
  // withdraw, or there is no Clip at all for it -- both read the same to
  // the member asking to unclip.
  nothingToUnclip: '이 메시지를 보관한 기록이 없습니다',
  // The handoff's `no permission` row. It is the only refusal copy the table
  // offers, so `/setup` reuses it even though the table phrases the refusal
  // in terms of archiving a message.
  noPermission: '이 서버에서 메시지를 보관할 권한이 없습니다',
  // Clip: the target is tombstoned (removed by author/admin) or cannot be
  // archived at all (deleted, invisible, unforwardable type). Neither is a
  // state the member can retry their way out of.
  invalidTarget: '이 메시지는 보관할 수 없습니다',
  // Any command: an infrastructure failure, retryable or not -- the handoff
  // table offers one bucket for both (§10.2's "infrastructure error").
  transientFailure: '보관하지 못했습니다. 다시 시도해 주세요',
  // The first-clip author DM (§11.1). `{guild}` and `{channel}` are literal
  // placeholders the sender substitutes; the handoff's template already
  // supplies the `#` before `{channel}`, so the substituted value is a plain
  // channel name, not a mention.
  firstArchivalDm:
    '회원님이 **{guild} / #{channel}** 에 남긴 메시지가 이 서버의 Clip 아카이브에 보관되었습니다.',
  firstArchivalDmViewOriginal: '원본 보기',
  firstArchivalDmRemoveFromArchive: '아카이브에서 제거',
} as const;
