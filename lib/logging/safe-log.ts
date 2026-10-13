/**
 * Structured log shape for Clip events, and for the Discord REST client's
 * rate-limit retries that serve them. Deliberately excludes any field that
 * could carry Discord message content (`content`, `embeds`, `attachments`):
 * operational logs must never dump message bodies (product spec §12).
 *
 * The archive is two messages -- a provenance line and the forward it
 * describes -- so it is two keys. A single `archiveMessageId` would let a call
 * site log one of the pair and believe it had identified the entry.
 */
export type SafeClipLog = {
  event: string;
  guildId?: string;
  sourceMessageId?: string;
  archiveProvenanceMessageId?: string;
  archiveForwardMessageId?: string;
  userId?: string;
  stateFrom?: string;
  stateTo?: string;
  errorCode?: string;
  /**
   * The step that failed: `source_read`, `forwardability_check` (no Discord
   * call), `provenance_post` or `forward_post` while archiving;
   * `forward_history_read` (no
   * `sourceMessageId`: it serves the whole page) or `forward_read` on the
   * archive page; `forward_read` when checking whether an
   * archive copy is gone.
   */
  step?: string;
  /** `http`, `timeout` or `network`; see `describeDiscordFailure`. */
  failure?: string;
  httpStatus?: string;
  discordCode?: string;
  /**
   * A retried Discord 429 (`discord.rate_limited`), or one asking for longer
   * than the client waits and thrown at once (`discord.rate_limited_gave_up`).
   * `route` is a path template from `discordRouteTemplate`, never the raw
   * path. `retryAfterMs` is the delay Discord asked for; `attempt` counts from 1.
   * Scope and bucket are Discord's `X-RateLimit-*` headers when sent;
   * `rateLimitGlobal` is `true` or `false`.
   */
  method?: string;
  route?: string;
  retryAfterMs?: string;
  attempt?: string;
  rateLimitScope?: string;
  rateLimitBucket?: string;
  rateLimitGlobal?: string;
  /**
   * A Discord request that took a second or longer, retries included
   * (`discord.slow_request`), with `route`, `attempt` and its outcome as
   * `httpStatus` or the `failure` facts.
   */
  durationMs?: string;
};

// The single source of truth for what may be logged. Built as an allowlist,
// not a denylist, so a field added to SafeClipLog in the future is the only
// thing that needs to change here too — a forbidden field added elsewhere
// (e.g. a call site casting through `any`) has no way to sneak onto this list.
const SAFE_KEYS = [
  'event',
  'guildId',
  'sourceMessageId',
  'archiveProvenanceMessageId',
  'archiveForwardMessageId',
  'userId',
  'stateFrom',
  'stateTo',
  'errorCode',
  'step',
  'failure',
  'httpStatus',
  'discordCode',
  'method',
  'route',
  'retryAfterMs',
  'attempt',
  'rateLimitScope',
  'rateLimitBucket',
  'rateLimitGlobal',
  'durationMs',
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
 *
 * The allowlist covers key *names* only. A value that arrives under an
 * allowlisted key but is itself an object or array (e.g. a message body
 * smuggled in as `{ userId: { content: '...' } }` through an untyped call
 * site) would otherwise pass straight through JSON.stringify intact — so a
 * non-string value is dropped rather than logged. Dropping, not coercing:
 * `String(value)` or a nested `JSON.stringify(value)` would still risk
 * printing exactly the content this function exists to keep out (e.g. an
 * array of strings joining into readable text). A missing field just makes
 * one log line less complete; a leaked one breaks the product's privacy
 * commitment. Only the cheaper failure is acceptable here.
 */
export function logClipEvent(entry: SafeClipLog): void {
  const safeEntry: Record<string, string> = {};
  for (const key of SAFE_KEYS) {
    const value = entry[key];
    if (typeof value === 'string') {
      safeEntry[key] = value;
    }
  }
  console.log(JSON.stringify(safeEntry));
}
