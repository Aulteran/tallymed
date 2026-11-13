const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the highlighted details and try again.',
  unauthenticated: 'Invalid email or password.',
  forbidden: 'You do not have permission to do that.',
  csrf_failed: 'The request could not be verified. Reload the page and try again.',
  not_found: 'That item was not found or has expired.',
  stale_version: 'This record changed since you loaded it. Reload and try again.',
  conflict: 'That could not be saved because it conflicts with existing records, for example an archived item, an adjustment that would make responsibility negative, an amount above the open balance of a bill or the unapplied cash of a payment, a stale schedule, or a request key already used with different details.',
  duplicate_warning: 'A similar bill already exists for this provider. Review the bills list, then tick "Save anyway" and submit again.',
  payload_too_large: 'That file is larger than the upload limit, or the household document storage limit has been reached.',
  unsupported_media_type: 'That file was not accepted. Use a PDF, PNG or JPEG whose contents match its type and that has no scripts or attachments inside.',
  duplicate_document: 'A document with identical contents already exists. Tick the box to upload it anyway, or attach the existing document.',
  storage_unavailable: 'Document storage is not available right now. Nothing was saved. Try again, or ask the operator to check the document volume.',
  rate_limited: 'Too many attempts. Wait fifteen minutes and try again.',
  internal: 'Something went wrong. Try again.',
};

export function errorMessage(code: string | string[] | undefined): string | null {
  return typeof code === 'string' ? (MESSAGES[code] ?? MESSAGES.internal!) : null;
}
