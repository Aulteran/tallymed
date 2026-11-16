import { InstallmentRows } from './InstallmentRows.tsx';
import { CADENCES, label } from './ui.tsx';

export interface ScheduleDefaults {
  inputMode?: string; totalAmount?: string; installmentCount?: string | number; installmentAmount?: string; remainder?: string; firstDueDate?: string; cadence?: string;
  /** "List each installment": the pasted text, the typed table rows, the line problems to show, and whether a Preview or an error kept only part of the list. */
  installmentsText?: string; instRows?: Array<{ dueDate: string; amount: string }>; listProblems?: string[]; listTrimmed?: boolean;
}

/**
 * The schedule inputs shared by creating a plan and revising one. Works without JavaScript: both groups of amount fields are always
 * shown and the chosen input mode says which ones are read. Nothing here is required by the browser; the server states what is missing.
 */
export function PlanScheduleFields({ idPrefix, defaults, restart = false }: { idPrefix: string; defaults: ScheduleDefaults; restart?: boolean }) {
  const mode = defaults.inputMode === 'per_installment' || defaults.inputMode === 'list' ? defaults.inputMode : 'total';
  const typedList = mode === 'list' || (defaults.instRows?.length ?? 0) > 0 || !!defaults.installmentsText;
  const id = (s: string) => `${idPrefix}-${s}`;
  return <>
    <fieldset>
      <legend>How do you want to set the amounts?</legend>
      <label className="checkbox"><input id={id('mode-total')} type="radio" name="inputMode" value="total" defaultChecked={mode === 'total'} /> It's going to be this many installments and at this much price</label>
      <label className="checkbox"><input id={id('mode-per')} type="radio" name="inputMode" value="per_installment" defaultChecked={mode === 'per_installment'} /> At this much paid per installment</label>
      <label className="checkbox"><input id={id('mode-list')} type="radio" name="inputMode" value="list" defaultChecked={mode === 'list'} /> List each installment myself (dates and amounts)</label>
      <p className="muted">
        First choice: give the total price and the number of installments, and the total is divided exactly.
        Second choice: give the amount paid each time, and either the number of installments (the total is the count times the amount) or the total
        (the count is worked out and the last installment takes what is left, so it can be smaller). If you give a count and a total that do not agree,
        the plan is saved as count times amount and the difference is shown on the plan.
        Third choice: type each installment's date and amount in the list further down (or paste a schedule); the total price, count, amount, first due date, cadence and leftover cents are then not used.
      </p>
    </fieldset>
    <label htmlFor={id('total')}>{restart ? 'Total still to schedule (USD)' : 'Total price (USD)'}</label>
    <input id={id('total')} name="totalAmount" inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" defaultValue={defaults.totalAmount} />
    <label htmlFor={id('count')}>Number of installments</label>
    <input id={id('count')} name="installmentCount" type="number" min={1} max={120} defaultValue={defaults.installmentCount} />
    <label htmlFor={id('amount')}>Amount per installment (USD, for "paid per installment")</label>
    <input id={id('amount')} name="installmentAmount" inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" defaultValue={defaults.installmentAmount} />
    <label htmlFor={id('remainder')}>Where leftover cents go (price and count only)</label>
    <select id={id('remainder')} name="remainder" defaultValue={defaults.remainder ?? 'earliest'}>
      <option value="earliest">One extra cent on each of the earliest installments</option>
      <option value="last_extra">All leftover cents on the last installment</option>
      <option value="last_short">Equal installments, and a smaller last installment</option>
    </select>
    <label htmlFor={id('first')}>{restart ? 'Restart from (first due date of the unpaid rest)' : 'First due date'}</label>
    <input id={id('first')} name="firstDueDate" type="date" defaultValue={defaults.firstDueDate} />
    <label htmlFor={id('cadence')}>Cadence</label>
    <select id={id('cadence')} name="cadence" defaultValue={defaults.cadence ?? 'monthly'}>{CADENCES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
    <details className="inst-list" open={typedList}>
      <summary>Installment list (used with "List each installment myself")</summary>
      <p className="muted">
        Give a date and an amount for each installment, in the table or pasted as text, not both. Only the choice above decides what is used: with another choice
        the table and the pasted text are ignored. The installments can be in any order and are saved by date. {restart ? 'With "keep the installments that are fully paid", the list describes only the unpaid rest. ' : ''}
        At most 120 installments.
      </p>
      {(defaults.listProblems?.length ?? 0) > 0 && <div className="error" role="alert">
        <p>The list cannot be used yet:</p>
        <ul>{defaults.listProblems!.map((t) => <li key={t}>{t}</li>)}</ul>
      </div>}
      {defaults.listTrimmed && <p className="muted" role="note">The list was too long to keep through the last step, so only the first rows or lines are shown. Check the end of the list before saving.</p>}
      <fieldset>
        <legend>Table of installments</legend>
        <InstallmentRows idPrefix={idPrefix} values={defaults.instRows ?? []} cadenceId={id('cadence')} totalId={id('total')} modeId={id('mode-list')} />
      </fieldset>
      <label htmlFor={id('paste')}>Paste a schedule</label>
      <textarea id={id('paste')} name="installmentsText" rows={6} maxLength={12000} spellCheck={false} defaultValue={defaults.installmentsText}
        placeholder={'One installment per line: a date and an amount.\n2026-09-01 40.00\n9/15/2026, $1,250.00'} />
      <p className="muted">Dates as YYYY-MM-DD or M/D/YYYY. Amounts may have a $ and thousands commas. Separate the date and the amount with a space, a comma or a tab. Blank lines are skipped. Problems are listed by line number.</p>
    </details>
  </>;
}