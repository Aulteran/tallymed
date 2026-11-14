/** Real screenshots of the application running on fabricated data (see scripts/capture-site-screenshots.mjs). All are 1440 x 900. */
export const screenSize = { width: 1440, height: 900 } as const;

export const screens = [
  {
    id: 'dashboard', label: 'Dashboard', file: 'overview',
    caption: 'The overview shows household responsibility, open balances, overdue installments and HSA totals at a glance.',
    alt: { light: 'TallyMed overview in the light theme: cards for confirmed responsibility, open balance, overdue and upcoming installments and HSA amounts, with a navigation sidebar on the left.', dark: 'TallyMed overview in the dark theme: cards for confirmed responsibility, open balance, overdue and upcoming installments and HSA amounts, with a navigation sidebar on the left.' },
  },
  {
    id: 'bills', label: 'Bills', file: 'bills',
    caption: 'Each provider’s bill is listed with its family member, visit, and whether the amount is an estimate or confirmed.',
    alt: { light: 'TallyMed bills list in the light theme: five example bills from different providers, each marked as an estimate or confirmed and linked to a visit or flagged as awaiting one.', dark: 'TallyMed bills list in the dark theme: five example bills from different providers, each marked as an estimate or confirmed and linked to a visit or flagged as awaiting one.' },
  },
  {
    id: 'plans', label: 'Payment Plans', file: 'plan',
    caption: 'A payment plan is a schedule of installments, matched to the payments actually made. Each shows as paid, partial, overdue or unpaid.',
    alt: { light: 'TallyMed payment plan page in the light theme: a six-installment schedule with matched amounts and statuses of paid, partial and overdue, and unpaid.', dark: 'TallyMed payment plan page in the dark theme: a six-installment schedule with matched amounts and statuses of paid, partial and overdue, and unpaid.' },
  },
  {
    id: 'hsa', label: 'HSA', file: 'hsa',
    caption: 'Each payment is decided eligible or not, claimed, and reconciled against reimbursements, with available, pending and received amounts.',
    alt: { light: 'TallyMed HSA reimbursements page in the light theme: totals for eligible, available, pending and received amounts above a table with one row per payment.', dark: 'TallyMed HSA reimbursements page in the dark theme: totals for eligible, available, pending and received amounts above a table with one row per payment.' },
  },
];

/** Screens with their image URLs. Resolve on the server (page code) and pass to client components: the base path is not known in the browser bundle. */
export function withSources(resolve: (path: string) => string) {
  return screens.map((screen) => ({ ...screen, src: { light: resolve(`/screens/${screen.file}-light.webp`), dark: resolve(`/screens/${screen.file}-dark.webp`) } }));
}
export type ScreenWithSources = ReturnType<typeof withSources>[number];
