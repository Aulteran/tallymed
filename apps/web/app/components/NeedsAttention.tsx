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
export function NeedsAttention({ sources }: { sources: AttentionSources }) {
  const items = attentionItems(sources);
  if (items.length === 0) return null;
  const moreDocuments = sources.unmatched.count - sources.unmatched.items.length;
  return <section className="attention" aria-labelledby="attention-title">
    <div className="attention-head">
      <h2 id="attention-title">Needs attention</h2>
      <span className="attention-count">{items.length} {items.length === 1 ? 'item' : 'items'}</span>
    </div>
    <ul>
      {items.map((item) => <li key={item.key} data-level={item.level}>
        <Link href={item.href}>{item.title}</Link>
        <p>{item.reason}</p>
        <ImportancePill level={item.level} />
      </li>)}
    </ul>
    {moreDocuments > 0 && <p className="attention-more"><Link href="/documents?unmatched=yes">{moreDocuments} more unmatched {moreDocuments === 1 ? 'document' : 'documents'}</Link></p>}
  </section>;
}
