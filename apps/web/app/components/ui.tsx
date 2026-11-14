import Link from 'next/link';
import type { ReactNode } from 'react';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { appContext } from '../../server/context.ts';
import { flashCookieName, readFlash } from '../../server/flash.ts';
import { AppError } from '../../server/errors.ts';
import { pageSession } from '../../server/http.ts';
import { formatCents } from '../../server/money.ts';
import { Icon } from './icons.tsx';
import { errorMessage } from './messages.ts';

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function requireSession() {
  const ctx = appContext();
  const session = await pageSession(ctx, await headers());
  if (!session) redirect('/login');
  // An account holding a temporary password reaches nothing but the change-password page.
  if (session.actor.mustChangePassword) redirect('/password/change');
  return { ctx, ...session };
}

/** First value of each query parameter, as plain strings. */
export async function flat(searchParams: SearchParams): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === 'string') out[k] = v;
  else if (Array.isArray(v) && v[0] !== undefined) out[k] = v[0];
  return out;
}

/**
 * Query parameters plus, after a validation error on this exact path, the values the person typed (kept in a short-lived
 * cookie rather than the URL). Query values win; the flash only fills fields the URL does not set.
 */
export async function flatWithFlash(searchParams: SearchParams, path: string): Promise<Record<string, string>> {
  const q = await flat(searchParams);
  if (!q.error) return q;
  const flash = readFlash((await cookies()).get(flashCookieName(appContext().config))?.value, path);
  return { ...flash, ...q };
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
  return <p className="actions"><Link className="button secondary" href={`${base}?${q}`}>Next page</Link></p>;
}

/** Shown in place of a list or table that has no rows. */
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty"><Icon name="empty" /><p>{children}</p></div>;

export const dateOf = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export function Options({ items, blank }: { items: Array<{ id: string; name: string; archived?: boolean }>; blank?: string }) {
  return <>
    {blank !== undefined && <option value="">{blank}</option>}
    {items.map((i) => <option key={i.id} value={i.id}>{i.name}{i.archived ? ' (archived)' : ''}</option>)}
  </>;
}

export const AMOUNT_SOURCES = ['statement', 'portal', 'eob', 'phone', 'manual'] as const;
export const ADJUSTMENT_CATEGORIES = ['insurer_adjustment', 'insurer_payment', 'provider_discount', 'financial_assistance', 'correction'] as const;
/** Account roles as shown to people. The stored value `operator` is the standard (non-administrator) role. */
export const roleLabel = (role: string) => (role === 'admin' ? 'Admin' : 'Standard');
export const label = (v: string) => v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Shown when a select list was cut at the page limit, so the person knows to search instead of assuming the list is complete. */
export const Truncated = ({ what }: { what: string }) => <p className="muted" role="note">Only the first 100 {what} are listed. Use the search below to narrow the list. The current choice is always kept.</p>;

/** A GET search that narrows select lists without touching the saved record. Values are plain text and bounded. */
export function NarrowForm({ fields, values, inDialog }: { fields: Array<{ name: string; label: string }>; values: Record<string, string>; /** Inside the add dialog: no card, and the result reopens the dialog. */ inDialog?: boolean }) {
  return <form method="get" className={inDialog ? 'row' : 'card row'} role="search" aria-label="Narrow the lists">
    {inDialog && <input type="hidden" name="add" value="1" />}
    {fields.map((f) => <div key={f.name}><label htmlFor={`n-${f.name}`}>{f.label}</label><input id={`n-${f.name}`} name={f.name} maxLength={80} defaultValue={values[f.name]} /></div>)}
    <div><button type="submit" className="secondary">Search</button></div>
  </form>;
}
/** The non-empty values of the named query parameters, for links and forms that must keep the current filters. */
export const pick = (values: Record<string, string>, keys: string[]): Record<string, string> => Object.fromEntries(keys.filter((k) => values[k]).map((k) => [k, values[k]!]));
export const q80 = (v: string | undefined) => (v ? v.slice(0, 80) : undefined);

export const PAYMENT_METHODS = ['card', 'bank_transfer', 'check', 'cash', 'portal', 'other'] as const;
export const CADENCES = ['monthly', 'biweekly', 'weekly'] as const;
export const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Installment state with a plain-language label; overdue is shown in addition to partial or unpaid. */
export function StatePill({ state, overdue }: { state: string; overdue?: boolean }) {
  return <>
    <span className={state === 'paid' ? 'pill' : 'pill warn'}>{label(state)}</span>{overdue ? <> <span className="pill warn">Overdue</span></> : null}
  </>;
}
