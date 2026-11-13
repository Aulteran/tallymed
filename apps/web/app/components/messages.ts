const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the highlighted details and try again.',
  unauthenticated: 'Invalid email or password.',
  forbidden: 'You do not have permission to do that.',
  csrf_failed: 'The request could not be verified. Reload the page and try again.',
  not_found: 'That item was not found or has expired.',
  stale_version: 'This record changed since you loaded it. Reload and try again.',
  conflict: 'That could not be saved because it conflicts with existing records, for example an archived item, an adjustment that would make responsibility negative, or a request key already used with different details.',
  duplicate_warning: 'A similar bill already exists for this provider. Review the bills list, then tick "Save anyway" and submit again.',
  rate_limited: 'Too many attempts. Wait fifteen minutes and try again.',
  internal: 'Something went wrong. Try again.',
};

export function errorMessage(code: string | string[] | undefined): string | null {
  return typeof code === 'string' ? (MESSAGES[code] ?? MESSAGES.internal!) : null;
}
