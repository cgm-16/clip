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
} as const;
