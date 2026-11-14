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
  storage_unavailable: 'Document storage is not available right now. Nothing was saved. Try again, or ask the server administrator to check the document volume.',
  busy: 'Several uploads are in progress. Wait a moment and try again.',
  invalid_setup_token: 'The setup token was not accepted. Use the value of TALLYMED_SETUP_TOKEN, or the token the server printed to its console when it started.',
  bootstrap_closed: 'Setup was already completed.',
  rate_limited: 'Too many attempts. Wait a few minutes (up to fifteen) and try again.',
  reauth_failed: 'Your password was not correct. Nothing was changed.',
  secrets_key_missing: 'The SMTP password cannot be saved because the server has no TALLYMED_SECRETS_KEY. Set it in the server environment (openssl rand -base64 32), restart, and try again.',
  password_change_required: 'Choose a new password before continuing.',
  temporary_password_expired: 'That temporary password has expired or was already used. Ask an administrator for a new one.',
  self_reset_blocked: 'You cannot reset your own password here. Use Password in the menu to change it.',
  reset_not_allowed: 'That account cannot be reset right now. It must be active, and the household must keep an administrator who can sign in.',
  confirmation_required: 'That range is very broad: every machine in it that can reach the app directly could forge client addresses. Tick the confirmation box if you are sure, or list only your proxy\'s own address.',
  email_not_configured: 'Password reset by email is not set up on this server. Ask an administrator to reset your password.',
  internal: 'Something went wrong. Try again.',
};

export function errorMessage(code: string | string[] | undefined): string | null {
  return typeof code === 'string' ? (MESSAGES[code] ?? MESSAGES.internal!) : null;
}
