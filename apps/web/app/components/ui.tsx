import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { appContext } from '../../server/context.ts';
import { AppError } from '../../server/errors.ts';
import { pageActor } from '../../server/http.ts';
import { formatCents } from '../../server/money.ts';
import { errorMessage } from './messages.ts';

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function requireSession() {
  const ctx = appContext();
  const session = await pageActor(ctx, await headers());
  if (!session) redirect('/login');
  return { ctx, ...session };
}

/** First value of each query parameter, as plain strings. */
export async function flat(searchParams: SearchParams): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === 'string') out[k] = v;
  else if (Array.isArray(v) && v[0] !== undefined) out[k] = v[0];
  return out;
}

/** Runs a read; a missing record becomes a 404 and a malformed filter becomes an inline message. */
export async function load<T>(fn: () => Promise<T>, fallback: T): Promise<{ data: T; invalid: boolean }> {
  try {
    return { data: await fn(), invalid: false };
  } catch (error) {
    if (error instanceof AppError && error.code === 'not_found') notFound();
    if (error instanceof AppError && error.code === 'invalid_input') return { data: fallback, invalid: true };
    throw error;
  }
}

export const newKey = () => randomUUID();
export const Money = ({ cents }: { cents: string }) => <span className="num">{formatCents(cents)}</span>;
export const Csrf = ({ token }: { token: string }) => <input type="hidden" name="csrf" value={token} />;

export function Banner({ code, invalid }: { code?: string; invalid?: boolean }) {
  const message = invalid ? errorMessage('invalid_input') : errorMessage(code);
  return message ? <p className="error" role="alert">{message}</p> : null;
}

export function Pager({ base, params, next }: { base: string; params: Record<string, string>; next: string | null }) {
  if (!next) return null;
  const q = new URLSearchParams({ ...params, cursor: next });
  return <p><Link href={`${base}?${q}`}>Next page</Link></p>;
}

export const dateOf = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export function Options({ items, blank }: { items: Array<{ id: string; name: string; archived?: boolean }>; blank?: string }) {
  return <>
    {blank !== undefined && <option value="">{blank}</option>}
    {items.map((i) => <option key={i.id} value={i.id}>{i.name}{i.archived ? ' (archived)' : ''}</option>)}
  </>;
}

export const AMOUNT_SOURCES = ['statement', 'portal', 'eob', 'phone', 'manual'] as const;
export const ADJUSTMENT_CATEGORIES = ['insurer_adjustment', 'insurer_payment', 'provider_discount', 'financial_assistance', 'correction'] as const;
export const label = (v: string) => v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
