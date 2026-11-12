// This file imports nothing, so that the live page's tests can load it to check, against the
// pass-through's own rule, the bodies the page sends.

/**
 * The longest `args_base64` forwarded. The largest arguments a view of either contract takes,
 * `get_buyer`'s u64 pool id and 64-character account id, are 152 characters of base64.
 */
const MAX_ARGS_BASE64 = 1024;

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` has exactly these keys. */
function hasExactKeys(value: Fields, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Whether `body` is a JSON-RPC 2.0 `query` of `request_type: "call_function"` on one of `accounts`,
 * at a `finality` or a `block_id`, with no other field at either level, and `args_base64` of at
 * most MAX_ARGS_BASE64 characters.
 */
export function isAllowedViewCall(body: unknown, accounts: string[]): boolean {
  if (!isFields(body) || !hasExactKeys(body, ['jsonrpc', 'id', 'method', 'params'])) return false;
  const { jsonrpc, id, method, params } = body;
  if (jsonrpc !== '2.0' || (typeof id !== 'string' && typeof id !== 'number') || method !== 'query') return false;
  if (!isFields(params)) return false;
  const byFinality = 'finality' in params;
  const block = byFinality
    ? typeof params.finality === 'string'
    : typeof params.block_id === 'string' || typeof params.block_id === 'number';
  return (
    hasExactKeys(params, ['request_type', 'account_id', 'method_name', 'args_base64', byFinality ? 'finality' : 'block_id']) &&
    block &&
    params.request_type === 'call_function' &&
    typeof params.account_id === 'string' &&
    accounts.includes(params.account_id) &&
    typeof params.method_name === 'string' &&
    typeof params.args_base64 === 'string' &&
    params.args_base64.length <= MAX_ARGS_BASE64
  );
}
