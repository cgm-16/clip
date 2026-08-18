import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { verifyInteractionRequest } from '@/lib/discord/verify-interaction';

// Discord signs `timestamp + body` with Ed25519 and sends the public key to
// us as hex; `verifyKey` expects that same encoding, so the test keypair is
// generated and exported the same way.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

function signBody(body: string, timestamp: string): string {
  return sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
}

describe('verifyInteractionRequest', () => {
  test('accepts a validly signed body', async () => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1700000000';
    const signature = signBody(body, timestamp);

    await expect(verifyInteractionRequest(body, signature, timestamp, publicKeyHex)).resolves.toBe(
      true,
    );
  });

  test('rejects a missing signature header', async () => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1700000000';

    await expect(
      verifyInteractionRequest(body, null, timestamp, publicKeyHex),
    ).resolves.toBe(false);
  });

  test('rejects a missing timestamp header', async () => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1700000000';
    const signature = signBody(body, timestamp);

    await expect(verifyInteractionRequest(body, signature, null, publicKeyHex)).resolves.toBe(
      false,
    );
  });

  test('rejects a signature that does not match the body', async () => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1700000000';
    const signature = signBody(body, timestamp);

    await expect(
      verifyInteractionRequest('{"type":2}', signature, timestamp, publicKeyHex),
    ).resolves.toBe(false);
  });
});
