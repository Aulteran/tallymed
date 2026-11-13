import { hash, verify } from '@node-rs/argon2';
import { AppError } from './errors.ts';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export function assertPasswordPolicy(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AppError('invalid_input', `Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`);
  }
}

// Argon2id with the library defaults (OWASP-aligned: 19 MiB, t=2, p=1).
export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return hash(password);
}

let dummy: Promise<string> | null = null;

/** Verifies a password; for unknown accounts burns comparable time against a dummy hash. */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  if (stored === null) {
    dummy ??= hash('tallymed-dummy-password');
    await verify(await dummy, password).catch(() => false);
    return false;
  }
  return verify(stored, password).catch(() => false);
}
