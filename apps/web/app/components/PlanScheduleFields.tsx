import { CADENCES, label } from './ui.tsx';

export interface ScheduleDefaults {
  inputMode?: string; totalAmount?: string; installmentCount?: string | number; installmentAmount?: string; remainder?: string; firstDueDate?: string; cadence?: string;
}

/**
 * The schedule inputs shared by creating a plan and revising one. Works without JavaScript: both groups of amount fields are always
 * shown and the chosen input mode says which ones are read. Nothing here is required by the browser; the server states what is missing.
 */
export function PlanScheduleFields({ idPrefix, defaults, restart = false }: { idPrefix: string; defaults: ScheduleDefaults; restart?: boolean }) {
  const mode = defaults.inputMode === 'per_installment' ? 'per_installment' : 'total';
  const id = (s: string) => `${idPrefix}-${s}`;
  return <>
    <fieldset>
      <legend>How do you want to set the amounts?</legend>
      <p><input id={id('mode-total')} type="radio" name="inputMode" value="total" defaultChecked={mode === 'total'} />{' '}
        <label htmlFor={id('mode-total')}>It's going to be this many installments and at this much price</label></p>
      <p><input id={id('mode-per')} type="radio" name="inputMode" value="per_installment" defaultChecked={mode === 'per_installment'} />{' '}
        <label htmlFor={id('mode-per')}>At this much paid per installment</label></p>
      <p className="muted">
        First choice: give the total price and the number of installments, and the total is divided exactly.
        Second choice: give the amount paid each time, and either the number of installments (the total is the count times the amount) or the total
        (the count is worked out and the last installment takes what is left, so it can be smaller). If you give a count and a total that do not agree,
        the plan is saved as count times amount and the difference is shown on the plan.
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
    <input id={id('first')} name="firstDueDate" type="date" required defaultValue={defaults.firstDueDate} />
    <label htmlFor={id('cadence')}>Cadence</label>
    <select id={id('cadence')} name="cadence" defaultValue={defaults.cadence ?? 'monthly'}>{CADENCES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
  </>;
}
