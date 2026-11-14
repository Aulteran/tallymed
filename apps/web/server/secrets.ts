// Encryption of the few secrets the application must store and later use (the SMTP password). AES-256-GCM with a per-setting key derived
// from TALLYMED_SECRETS_KEY by HKDF-SHA256, a fresh 96-bit nonce per encryption and the setting's name as authenticated data, so a ciphertext
// cannot be moved to another setting. The stored form is `v1.<key id>.<nonce>.<tag>.<ciphertext>` (base64url). The key id is a short digest of the
// key, so a rotated or wrong key is reported as such instead of as corruption. A secret is never returned to a browser or written to a log.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export function keyId(key: Buffer): string {
  return createHash('sha256').update('tallymed-secret-key-id').update(key).digest('hex').slice(0, 8);
}

function derive(key: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, 'tallymed-secrets-v1', `purpose:${purpose}`, 32));
}

export function encryptSecret(key: Buffer, purpose: string, plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(key, purpose), nonce);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, keyId(key), nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export type DecryptResult = { status: 'ok'; value: string } | { status: 'key_mismatch' } | { status: 'corrupt' };

export function decryptSecret(key: Buffer, purpose: string, stored: string): DecryptResult {
  const parts = stored.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return { status: 'corrupt' };
  if (parts[1] !== keyId(key)) return { status: 'key_mismatch' };
  try {
    const decipher = createDecipheriv('aes-256-gcm', derive(key, purpose), Buffer.from(parts[2]!, 'base64url'));
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[3]!, 'base64url'));
    return { status: 'ok', value: Buffer.concat([decipher.update(Buffer.from(parts[4]!, 'base64url')), decipher.final()]).toString('utf8') };
  } catch {
    return { status: 'corrupt' };
  }
}
