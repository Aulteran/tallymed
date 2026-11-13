import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function csrfFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update('tallymed-csrf-v1').digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function emailKey(email: string): Buffer {
  return digest(email.trim().toLowerCase());
}
