const SENSITIVE = /pass|token|secret|cookie|authorization|csrf|email|hash|session|invite|key/i;

/** Returns a copy with sensitive-looking fields replaced. Used for every structured log line. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export type LogSink = (line: string) => void;
let sink: LogSink = (line) => process.stderr.write(line + '\n');
export function setLogSink(next: LogSink) { sink = next; }

export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) {
  sink(JSON.stringify({ level, event, ...(redact(fields) as object) }));
}

/** Errors are logged by name and code only: messages from drivers can echo query parameters. */
export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}) {
  const e = error as { name?: string; code?: string };
  log('error', event, { ...fields, errorName: e?.name ?? 'Error', errorCode: e?.code });
}
