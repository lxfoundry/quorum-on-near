import { TypedError } from 'near-api-js';
import { GatewayResponseError } from './gateway.ts';

/**
 * How errors are written for people and agents. Library and RPC messages can hold the RPC URL, which
 * may carry an API key, and near-api-js makes the body of an RPC's 429 answer the message, so that
 * text is the RPC's. Text meant for an agent or for a buyer's log line is therefore the caller's own,
 * plus at most transportReason; the full message chain goes only to the operator's standard error,
 * through describeError, which redacts the RPC URL.
 */

/** What a redacted RPC URL is replaced with: the variable that holds it. */
const REDACTED = 'QUORUM_RPC_URL';
/** How many causes are followed. */
const MAX_DEPTH = 8;
/** An errno or undici code: an identifier, never free text. */
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/**
 * A short reason for a failed request that never quotes a message: `HTTP <status>` for an answer of
 * the RPC (near-api-js's provider error) or an undocumented answer of the gateway (GatewayResponseError),
 * the socket's errno or undici code behind fetch's `fetch failed` (an AggregateError's own code, or
 * its first error's), `retries exceeded` for near-api-js's RetriesExceeded, and otherwise `error`.
 * The causes of a wrapping error are looked through.
 */
export function transportReason(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH && current instanceof Error; depth += 1) {
    const reason = ownReason(current);
    if (reason !== undefined) return reason;
    current = current.cause;
  }
  return 'error';
}

function ownReason(error: Error): string | undefined {
  if (error instanceof GatewayResponseError) return `HTTP ${error.status}`;
  if (error instanceof TypedError) return error.type === 'RetriesExceeded' ? 'retries exceeded' : undefined;
  // near-api-js's provider error carries the HTTP status as its cause.
  if (isHttpStatus(error.cause)) return `HTTP ${error.cause}`;
  return codeOf(error) ?? (error instanceof AggregateError ? codeOf(error.errors[0]) : undefined);
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && CODE.test(code) ? code : undefined;
}

/**
 * `text` with every occurrence of `rpcUrl` replaced by `QUORUM_RPC_URL`: the URL as written, as the
 * URL parser writes it, and with or without its trailing slash. A URL written another way is missed,
 * so redaction only backs up the rule that agents and buyers' log lines get no library text.
 */
export function redact(text: string, rpcUrl: string | undefined): string {
  if (rpcUrl === undefined || rpcUrl === '') return text;
  const forms = new Set([rpcUrl, rpcUrl.replace(/\/+$/, '')]);
  if (URL.canParse(rpcUrl)) {
    const { href } = new URL(rpcUrl);
    forms.add(href);
    forms.add(href.replace(/\/+$/, ''));
  }
  forms.delete('');
  // The longest first, so that a form inside another is not left with a piece of the longer one.
  const ordered = [...forms].sort((a, b) => b.length - a.length);
  return ordered.reduce((redacted, form) => redacted.replaceAll(form, REDACTED), text);
}

/**
 * The error's message, then each cause's in brackets, an AggregateError with no message of its own
 * giving its errors' messages (such as a connection refused on each address of a host), and an error
 * with no message its name; with `rpcUrl` redacted. For the operator's standard error only: it holds
 * library and RPC text.
 */
export function describeError(error: unknown, rpcUrl: string | undefined): string {
  return redact(describe(error, 0, new Set()), rpcUrl);
}

function describe(error: unknown, depth: number, seen: Set<unknown>): string {
  if (!(error instanceof Error)) return asText(error);
  seen.add(error);
  let text = error.message;
  if (error instanceof AggregateError && error.errors.length > 0 && depth < MAX_DEPTH) {
    const inner = error.errors.map((e: unknown) => describe(e, depth + 1, seen)).join('; ');
    text = text === '' ? inner : `${text} (${inner})`;
  }
  if (text === '') text = error.name;
  const { cause } = error;
  if (cause instanceof Error && !seen.has(cause) && depth < MAX_DEPTH) text = `${text} (${describe(cause, depth + 1, seen)})`;
  return text;
}

function asText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'a value that has no text';
  }
}
