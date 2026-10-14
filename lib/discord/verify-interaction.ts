import { verifyKey } from 'discord-interactions';

/** How far the signed timestamp may sit from now, in seconds, before a replayed request is refused. */
const MAX_TIMESTAMP_SKEW_SECONDS = 300;

/**
 * Verifies a Discord interaction request's Ed25519 signature against the raw
 * request body. Takes plain values rather than a `Request` so it stays
 * unit-testable without constructing one; the route handler does the HTTP
 * work of extracting these from headers.
 *
 * A missing signature or timestamp fails closed rather than being passed
 * into `verifyKey`, which expects both as strings. A signed timestamp that is
 * not an integer, or is more than `MAX_TIMESTAMP_SKEW_SECONDS` from
 * `nowSeconds`, fails too: the signature covers it, so it bounds how long a
 * captured request can be replayed.
 */
export async function verifyInteractionRequest(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!signature || !timestamp) {
    return false;
  }
  if (!(await verifyKey(rawBody, signature, timestamp, publicKey))) {
    return false;
  }
  return /^\d+$/.test(timestamp) && Math.abs(nowSeconds - Number(timestamp)) <= MAX_TIMESTAMP_SKEW_SECONDS;
}
