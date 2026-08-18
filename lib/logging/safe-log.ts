/**
 * Structured log shape for Clip events. Deliberately excludes any field that
 * could carry Discord message content (`content`, `embeds`, `attachments`):
 * operational logs must never dump message bodies (product spec §12).
 */
export type SafeClipLog = {
  event: string;
  guildId?: string;
  sourceMessageId?: string;
  archiveMessageId?: string;
  userId?: string;
  stateFrom?: string;
  stateTo?: string;
  errorCode?: string;
};

// The single source of truth for what may be logged. Built as an allowlist,
// not a denylist, so a field added to SafeClipLog in the future is the only
// thing that needs to change here too — a forbidden field added elsewhere
// (e.g. a call site casting through `any`) has no way to sneak onto this list.
const SAFE_KEYS = [
  'event',
  'guildId',
  'sourceMessageId',
  'archiveMessageId',
  'userId',
  'stateFrom',
  'stateTo',
  'errorCode',
] as const satisfies readonly (keyof SafeClipLog)[];

/**
 * Logs a Clip event as one line of JSON, keeping only the allowlisted keys.
 *
 * `entry` is typed as `SafeClipLog`, which already rejects `content`,
 * `embeds` and `attachments` at typed call sites. But TypeScript types are
 * erased at runtime, so a value that arrives via `any` or a JSON boundary
 * can still carry those fields; only reading the allowlisted keys off
 * `entry` is what keeps them out of the log regardless of how the value
 * arrived.
 */
export function logClipEvent(entry: SafeClipLog): void {
  const safeEntry: Record<string, string> = {};
  for (const key of SAFE_KEYS) {
    const value = entry[key];
    if (value !== undefined) {
      safeEntry[key] = value;
    }
  }
  console.log(JSON.stringify(safeEntry));
}
