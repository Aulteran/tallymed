export const features = [
  { title: 'Visits and bills', text: 'Record a visit once and attach the separate bills from the facility, clinician and lab, with estimates kept apart from confirmed amounts.' },
  { title: 'Payments and installment plans', text: 'Track what the household actually paid, schedule installments, and see which are upcoming, partial, paid or overdue.' },
  { title: 'Reimbursement', text: 'Review eligible out-of-pocket payments, record HSA claims and receipts, and reconcile partial or rejected reimbursements.' },
  { title: 'Documents', text: 'Keep statements, explanations of benefits and receipts privately, linked to the bills and payments they support.' },
  { title: 'Family overview', text: 'See balances, upcoming installments and reimbursement status for each family member, then drill down to the records.' },
  { title: 'Private self-hosting', text: 'Run it on hardware you control. Your records stay with your household and the ledger works without any AI service.' },
] as const;

export const steps = [
  { title: 'Visit', text: 'Record who was seen, when, and by which provider.' },
  { title: 'Bills', text: 'Add each provider’s bill, with insurer adjustments and what the household owes.' },
  { title: 'Payments', text: 'Log actual payments and match them to bills or installments.' },
  { title: 'HSA reconciliation', text: 'Mark eligible payments, submit claims and reconcile what was reimbursed.' },
] as const;

export const faq = [
  { q: 'Can I use TallyMed today?', a: 'Not yet. The project is in development, and everything described here is planned. The roadmap shows current progress.' },
  { q: 'Is it free and open source?', a: 'Yes. TallyMed is published under the GNU AGPL v3 and the source is on GitHub.' },
  { q: 'Where is my data stored?', a: 'On your own server. Each installation serves one household, and there is no hosted service or public registration.' },
  { q: 'Do I need an AI service?', a: 'No. AI assistance is optional. The ledger works fully with manual entry.' },
  { q: 'Does the site track visitors?', a: 'No. This site uses no analytics, cookies or sign-up forms.' },
  { q: 'Does it file HSA claims or give tax advice?', a: 'No. It helps you keep records and reconcile reimbursements. Claim submission and tax decisions stay with you and your administrator.' },
] as const;
