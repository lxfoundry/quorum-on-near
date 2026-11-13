import { ViewCache } from './view-cache.ts';
import { isAllowedViewCall } from './view-call.ts';

/** A block hash as the RPC writes it: 32 bytes in base58, which takes 32 to 44 characters. */
const BLOCK_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The accounts whose views the forward may answer from memory. */
export interface PageViewAccounts {
  poolsContract: string;
  token: string;
}

/** An answer of the RPC as the forward reads it: its HTTP status and its JSON body. */
interface RpcAnswer {
  status: number;
  body: unknown;
}

/** The fields this module reads of a view call that isAllowedViewCall accepted. */
interface ViewCall {
  id: string | number;
  params: {
    account_id: string;
    method_name: string;
    args_base64: string;
    finality?: string;
    block_id?: string | number;
  };
}

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The view call a forwarded request carries, or null when its body is not one the pass-through allows. */
function viewCallOf(init: RequestInit | undefined, accounts: PageViewAccounts): ViewCall | null {
  if (typeof init?.body !== 'string') return null;
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return null;
  }
  // The pass-through's own rule fixes `jsonrpc`, `method` and `request_type`, and allows no other
  // field, so a key made of the remaining fields covers everything the answer depends on.
  return isAllowedViewCall(body, [accounts.poolsContract, accounts.token]) ? (body as ViewCall) : null;
}

/**
 * The cache key of one of the live page's views, or null for a call that is never cached:
 * `get_pool` and `list_pools` on the pools contract at `final` finality, and `get_seats` on the
 * pools contract and `ft_balance_of` on the token at a block hash. The key holds the block reference
 * with its kind, the account, the method and `args_base64` as sent, and leaves out the `id`.
 */
function pageViewKey({ params }: ViewCall, accounts: PageViewAccounts): string | null {
  const { account_id: account, method_name: method, args_base64: args } = params;
  if ('finality' in params) {
    const cached = params.finality === 'final' && account === accounts.poolsContract && (method === 'get_pool' || method === 'list_pools');
    return cached ? JSON.stringify(['finality', params.finality, account, method, args]) : null;
  }
  // An answer at a block hash never changes. A height is left out: it can name a block that is not
  // final yet.
  const block = params.block_id;
  const cached =
    typeof block === 'string' &&
    BLOCK_HASH.test(block) &&
    ((account === accounts.poolsContract && method === 'get_seats') || (account === accounts.token && method === 'ft_balance_of'));
  return cached ? JSON.stringify(['block_id', block, account, method, args]) : null;
}

/**
 * Whether an answer may be stored: HTTP 200 and a JSON-RPC result holding a view's bytes and the
 * hash of the block they were read at, with no error at either level.
 */
function isViewResult({ status, body }: RpcAnswer): boolean {
  if (status !== 200 || !isFields(body) || body.jsonrpc !== '2.0' || Object.hasOwn(body, 'error')) return false;
  const { result } = body;
  return isFields(result) && !Object.hasOwn(result, 'error') && Array.isArray(result.result) && typeof result.block_hash === 'string';
}

/**
 * `answer` as a response of its own, with the caller's JSON-RPC id when its body is a JSON-RPC answer.
 * The stored body is shared by every caller, so it is copied, never changed.
 */
function reply({ status, body }: RpcAnswer, id: string | number): Response {
  const json = isFields(body) && Object.hasOwn(body, 'jsonrpc') ? { ...body, id } : body;
  return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * `inner`, the `POST /rpc` forward's fetch, answering the live page's repeated views (pageViewKey)
 * from a ViewCache: an answer is served for VIEW_CACHE_TTL_MS from when its read was sent, and the
 * requests for a view that arrive while its read is in flight share that read. Each of them is
 * answered with its own JSON-RPC id, at the RPC's status. Only a view's result is stored
 * (isViewResult). A read that fails, or whose answer is not JSON, rejects every request that shared
 * it, as the forward's fetch would. Every other request is passed to `inner` as it came, and its
 * answer comes back as `inner` gave it.
 */
export function cachePageViews(inner: typeof fetch, accounts: PageViewAccounts): typeof fetch {
  const contracts: PageViewAccounts = { poolsContract: accounts.poolsContract, token: accounts.token };
  const cache = new ViewCache<RpcAnswer>({ keep: isViewResult });
  return async (input, init) => {
    const call = viewCallOf(init, contracts);
    const key = call === null ? null : pageViewKey(call, contracts);
    if (call === null || key === null) return inner(input, init);
    const answer = await cache.get(key, async () => {
      const upstream = await inner(input, init);
      return { status: upstream.status, body: await upstream.json() };
    });
    return reply(answer, call.id);
  };
}
