import Link from 'next/link';
import type { ReactNode } from 'react';
import { Money } from './ui.tsx';

/** How soon a person should act. Presentation only: it orders the list and labels each row; it changes no record. */
export type Importance = 'critical' | 'normal' | 'low';
const LEVEL_LABEL: Record<Importance, string> = { critical: 'Critical', normal: 'Normal', low: 'Low' };
const LEVEL_ORDER: Record<Importance, number> = { critical: 0, normal: 1, low: 2 };

export type AttentionItem = { key: string; href: string; title: ReactNode; reason: ReactNode; level: Importance };

type Bill = { id: string; providerName: string; memberName: string; statementDate: string };
export type AttentionSources = {
  overdue: Array<{ installmentId: string; planId: string; planName: string; seq: number | string; dueDate: string; unpaidCents: string }>;
  needsReview: Array<{ allocationId: string; memberName: string; billLabel: string; paidOn: string; needsReviewCents: string }>;
  unmatched: { count: number; items: Array<{ id: string; title: string }> };
  awaitingVisit: Bill[];
  estimates: Array<Bill & { responsibilityCents: string }>;
  duplicates: Array<Bill & { providerReference: string | null }>;
};

/** Each queue arrives capped (the overview asks for at most this many per queue), so a full queue gets a "see all" link. */
export const QUEUE_LIMIT = 5;
/** Where each queue's full list lives, and the exact total where the overview already has one for the same filters. */
export type AttentionMore = {
  overdue: string; needsReview: { href: string; total: number }; unmatched: string;
  awaitingVisit: { href: string; total: number }; estimates: string; duplicates: string;
};
type MoreLink = { key: string; href: string; text: string };

/** One link per queue that may hold more than the rows shown. Exact counts are used only where they match the list's filters. */
export function moreLinks(s: AttentionSources, more: AttentionMore): MoreLink[] {
  const links: MoreLink[] = [];
  const counted = (key: string, shown: number, total: number, href: string, one: string, many: string) => {
    const rest = total - shown;
    if (rest > 0) links.push({ key, href, text: `${rest} more ${rest === 1 ? one : many}` });
  };
  const full = (key: string, shown: number, href: string, text: string) => { if (shown >= QUEUE_LIMIT) links.push({ key, href, text }); };
  // The plans list is not filtered by family member or provider, so the link says it opens the whole family's list.
  full('overdue', s.overdue.length, more.overdue, 'See all overdue installments (all family)');
  counted('needsReview', s.needsReview.length, more.needsReview.total, more.needsReview.href, 'HSA payment that needs review', 'HSA payments that need review');
  counted('unmatched', s.unmatched.items.length, s.unmatched.count, more.unmatched, 'unmatched document', 'unmatched documents');
  counted('awaitingVisit', s.awaitingVisit.length, more.awaitingVisit.total, more.awaitingVisit.href, 'bill awaiting a visit', 'bills awaiting a visit');
  full('estimates', s.estimates.length, more.estimates, 'See all estimates to confirm');
  full('duplicates', s.duplicates.length, more.duplicates, 'See all possible duplicates');
  return links;
}

/**
 * Turns the overview's existing queues into one list. Overdue installments and HSA payments above their ceiling are
 * Critical (money is late, or new claims are frozen); records that are incomplete are Normal; duplicate hints are Low.
 */
export function attentionItems(s: AttentionSources): AttentionItem[] {
  const items: AttentionItem[] = [
    ...s.overdue.map((i) => ({
      key: `inst-${i.installmentId}`, href: `/plans/${i.planId}`, level: 'critical' as const,
      title: <>{i.planName} · installment {i.seq}</>,
      reason: <>Overdue since {i.dueDate}. <Money cents={i.unpaidCents} /> is still unpaid.</>,
    })),
    ...s.needsReview.map((a) => ({
      key: `hsa-${a.allocationId}`, href: `/hsa/allocations/${a.allocationId}`, level: 'critical' as const,
      title: <>{a.memberName} · {a.billLabel} · paid {a.paidOn}</>,
      reason: <>HSA claims and reimbursements are <Money cents={a.needsReviewCents} /> above the eligible amount. New claims are frozen until it is reviewed.</>,
    })),
    ...s.unmatched.items.map((d) => ({
      key: `doc-${d.id}`, href: `/documents/${d.id}`, level: 'normal' as const,
      title: d.title, reason: <>Unmatched document: it is not attached to any record yet.</>,
    })),
    ...s.awaitingVisit.map((b) => ({
      key: `visit-${b.id}`, href: `/bills/${b.id}`, level: 'normal' as const,
      title: <>{b.providerName} · {b.memberName} · {b.statementDate}</>, reason: <>This bill is not linked to a visit.</>,
    })),
    ...s.estimates.map((b) => ({
      key: `est-${b.id}`, href: `/bills/${b.id}`, level: 'normal' as const,
      title: <>{b.providerName} · {b.memberName} · {b.statementDate}</>,
      reason: <>The amount of <Money cents={b.responsibilityCents} /> is an estimate. Confirm it from the statement.</>,
    })),
    ...s.duplicates.map((b) => ({
      key: `dup-${b.id}`, href: `/bills/${b.id}`, level: 'low' as const,
      title: <>{b.providerName} · {b.providerReference ?? 'no reference'} · {b.statementDate}</>,
      reason: <>Looks like another bill. This is a hint only; TallyMed never merges bills automatically.</>,
    })),
  ];
  // Stable sort keeps each queue's own order inside a level.
  return items.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

export const ImportancePill = ({ level }: { level: Importance }) =>
  <span className={`level level-${level}`}><span className="sr-only">Importance: </span>{LEVEL_LABEL[level]}</span>;

/** The overview's action list. Renders nothing at all when no item needs a person. */
export function NeedsAttention({ sources, more }: { sources: AttentionSources; more: AttentionMore }) {
  const items = attentionItems(sources);
  if (items.length === 0) return null;
  const links = moreLinks(sources, more);
  // With a capped queue the rows are not the total, so the header says how many are shown rather than implying a count.
  const count = links.length > 0 ? `Showing ${items.length}, most urgent first` : `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
  return <section className="attention" aria-labelledby="attention-title">
    <div className="attention-head">
      <h2 id="attention-title">Needs attention</h2>
      <span className="attention-count">{count}</span>
    </div>
    <ul>
      {items.map((item) => <li key={item.key} data-level={item.level}>
        <Link href={item.href}>{item.title}</Link>
        <p>{item.reason}</p>
        <ImportancePill level={item.level} />
      </li>)}
    </ul>
    {links.length > 0 && <ul className="attention-more" aria-label="More items">
      {links.map((l) => <li key={l.key}><Link href={l.href}>{l.text}</Link></li>)}
    </ul>}
  </section>;
}
