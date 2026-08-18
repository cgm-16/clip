import { verifyKey } from 'discord-interactions';

/**
 * Verifies a Discord interaction request's Ed25519 signature against the raw
 * request body. Takes plain values rather than a `Request` so it stays
 * unit-testable without constructing one; the route handler does the HTTP
 * work of extracting these from headers.
 *
 * A missing signature or timestamp fails closed rather than being passed
 * into `verifyKey`, which expects both as strings.
 */
export async function verifyInteractionRequest(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string,
): Promise<boolean> {
  if (!signature || !timestamp) {
    return false;
  }
  return verifyKey(rawBody, signature, timestamp, publicKey);
}
