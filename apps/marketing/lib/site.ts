import { deployment } from './deployment.mjs';

/** Public repository used when no repository is configured at build time. */
const fallbackSource = 'https://github.com/Aulteran/tallymed';
export const source = deployment.source ?? fallbackSource;

export const links = {
  source,
  license: source + '/blob/main/LICENSE',
  docs: source + '/tree/main/docs',
  contributing: source + '/issues',
  features: '#features',
} as const;

/** Absolute public URL for a route path such as "/roadmap/". */
export function absoluteUrl(path = '/'): string {
  return deployment.url + path;
}

export const tagline = 'Medical expenses, accounted for.';
export const siteDescription =
  'TallyMed is an open source, self-hosted ledger for one family’s medical bills, payment plans and HSA reimbursements. It is in development.';

export const ogImages = [{ url: absoluteUrl('/og.png'), width: 1200, height: 630, alt: 'TallyMed ledger and medical cross mark' }];
