import { AppError } from './errors.ts';

/** Opaque keyset cursor: the sort key values of the last row returned, validated on the way back in. */
export function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined, length: number): string[] | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === length && parsed.every((p) => typeof p === 'string' && p.length <= 200)) return parsed as string[];
  } catch {
    // Fall through to the uniform error.
  }
  throw new AppError('invalid_input', 'Invalid cursor');
}

export interface Page<T> { items: T[]; nextCursor: string | null }

/** Fetch limit+1 rows, return limit and a cursor when more remain. */
export function pageOf<T>(rows: T[], limit: number, keyOf: (row: T) => string[]): Page<T> {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(keyOf(items[items.length - 1]!)) : null };
}
