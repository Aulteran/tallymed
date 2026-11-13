// Exact USD money handling. Amounts are integer cents held as bigint; floats are never used.

/** Largest accepted single amount: $100,000,000,000.00, which keeps any realistic sum far below bigint limits. */
export const MAX_CENTS = 10_000_000_000_000n;

const DOLLARS = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/;

/** Parses a strict decimal USD string ("12", "12.5", "12.50") to cents. Rejects fractional cents, exponents and junk. */
export function parseUsd(input: string): bigint {
  const m = DOLLARS.exec(input.trim());
  if (!m) throw new RangeError('invalid amount');
  const cents = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  const value = m[1] === '-' ? -cents : cents;
  if (value > MAX_CENTS || value < -MAX_CENTS) throw new RangeError('amount out of range');
  return value;
}

/** Parses an amount for operations that do not accept negatives. */
export function parseNonNegativeUsd(input: string): bigint {
  const v = parseUsd(input);
  if (v < 0n) throw new RangeError('negative amount');
  return v;
}

/** Parses cents transmitted as a decimal integer string (API wire format). */
export function parseCentsString(input: string): bigint {
  if (!/^-?\d{1,14}$/.test(input)) throw new RangeError('invalid cents');
  const v = BigInt(input);
  if (v > MAX_CENTS || v < -MAX_CENTS) throw new RangeError('amount out of range');
  return v;
}

/** Display boundary only: "$1,234.50" or "-$12.00". */
export function formatCents(value: bigint | string): string {
  const v = typeof value === 'string' ? BigInt(value) : value;
  const abs = v < 0n ? -v : v;
  const dollars = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0n ? '-' : ''}$${dollars}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** Plain decimal dollars for form defaults ("12.50"). */
export function centsToUsdInput(value: bigint | string): string {
  const v = typeof value === 'string' ? BigInt(value) : value;
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
