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

    await expect(
      verifyInteractionRequest(body, signature, timestamp, publicKeyHex, 1700000000),
    ).resolves.toBe(true);
  });

  test.each([
    ['300 seconds old', 1700000000 - 300, true],
    ['301 seconds old', 1700000000 - 301, false],
    ['300 seconds in the future', 1700000000 + 300, true],
    ['301 seconds in the future', 1700000000 + 301, false],
  ])('a correctly signed timestamp %s', async (_name, signedAt, accepted) => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = String(signedAt);
    const signature = signBody(body, timestamp);

    await expect(
      verifyInteractionRequest(body, signature, timestamp, publicKeyHex, 1700000000),
    ).resolves.toBe(accepted);
  });

  test.each(['abc', '1700000000.5', ' 1700000000', '1e9'])(
    'rejects a correctly signed non-integer timestamp %j',
    async (timestamp) => {
      const body = JSON.stringify({ type: 1 });
      const signature = signBody(body, timestamp);

      await expect(
        verifyInteractionRequest(body, signature, timestamp, publicKeyHex, 1700000000),
      ).resolves.toBe(false);
    },
  );

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
