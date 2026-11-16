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

// ---------- security PIN ----------
// A PIN unlocks an already signed-in session; it never signs anyone in. Six digits are guessable offline by anyone who holds the hash,
// so the hash is only defence in depth: the real control is the attempt limit on the session (see services/pin.ts).
export const PIN_PATTERN = /^\d{6}$/;

export function assertPinPolicy(pin: string) {
  if (!PIN_PATTERN.test(pin)) throw new AppError('invalid_input', 'The PIN must be exactly six digits');
}

export async function hashPin(pin: string): Promise<string> {
  assertPinPolicy(pin);
  return hash(pin);
}

let dummyPin: Promise<string> | null = null;

/** Verifies a PIN; with no stored hash it burns comparable time, so timing does not reveal whether an account has a PIN. */
export async function verifyPin(stored: string | null, pin: string): Promise<boolean> {
  if (!PIN_PATTERN.test(pin)) return false;
  if (stored === null) {
    dummyPin ??= hash('000000');
    await verify(await dummyPin, pin).catch(() => false);
    return false;
  }
  return verify(stored, pin).catch(() => false);
}

/**
 * The PIN of a new account form: both fields empty means no PIN yet (the person is prompted later), otherwise the two must match
 * and be six digits. Hashing happens here, outside any transaction, like the password.
 */
export async function hashNewPin(pin: string | undefined, confirmPin: string | undefined): Promise<string | null> {
  if (pin === undefined && confirmPin === undefined) return null;
  if (pin === undefined || confirmPin === undefined) throw new AppError('invalid_input', 'Enter the PIN twice');
  assertPinPolicy(pin);
  if (pin !== confirmPin) throw new AppError('invalid_input', 'The two PINs do not match');
  return hashPin(pin);
}
