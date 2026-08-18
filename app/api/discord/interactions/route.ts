import { parseEnv } from '@/lib/env';
import { verifyInteractionRequest } from '@/lib/discord/verify-interaction';

// Discord's PING (type 1) handshake, answered with PONG (type 1), is what
// lets Discord accept this URL as the app's interaction endpoint.
const PING_INTERACTION_TYPE = 1;

export async function POST(request: Request) {
  // Read the raw body before anything parses it as JSON: `verifyKey` signs
  // over the exact bytes Discord sent, so a parse-then-restringify round
  // trip could produce a body that no longer matches the signature.
  const rawBody = await request.text();
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');

  // parseEnv is called per-request rather than at module load so a missing
  // env var fails a request, not the build (env vars are absent in CI).
  const env = parseEnv(process.env);

  const isValid = await verifyInteractionRequest(
    rawBody,
    signature,
    timestamp,
    env.DISCORD_PUBLIC_KEY,
  );
  if (!isValid) {
    // Missing signature, missing timestamp, and a bad signature all return
    // the same 401 with no detail, so an attacker learns nothing about which
    // check failed.
    return new Response(null, { status: 401 });
  }

  const interaction = JSON.parse(rawBody);
  if (interaction.type === PING_INTERACTION_TYPE) {
    return Response.json({ type: PING_INTERACTION_TYPE });
  }

  return new Response(null, { status: 501 });
}
