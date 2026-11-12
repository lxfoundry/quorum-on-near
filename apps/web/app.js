/**
 * The live page. It reads the gateway's `/config.json` and the token's `ft_metadata` once, then
 * every 2 seconds the pools contract's views (through the RPC the configuration names) and the
 * gateway's activity feed, and renders one of the provider's pools. It never signs anything.
 *
 * Every value read from the RPC or the gateway is written with `textContent` or as an attribute,
 * never as HTML. The computing is in `totals.js`; this module only fetches and renders.
 */
import {
  buyerRows,
  countdownText,
  formatAmount,
  parseActivity,
  parseBalance,
  parseConfig,
  parsePoolRefs,
  parseSeats,
  parseToken,
  payoutLinks,
  poolChoices,
  poolParam,
  poolToShow,
  poolTotals,
  readAll,
  viewRequest,
  viewResult,
} from './totals.js';

/** @import { ActivityRecord, BlockRef, BuyerRow, PageConfig, PoolStatus, PoolView, SeatView, TokenInfo, TxLink, ViewAnswer } from './totals.js' */

/** @type {BlockRef} */
const FINAL = { finality: 'final' };
const POLL_INTERVAL_MS = 2_000;
const COUNTDOWN_INTERVAL_MS = 1_000;
/** How long one request may take. A poll waits for its requests, and the next poll waits for it. */
const REQUEST_TIMEOUT_MS = 10_000;

/** @type {Record<PoolStatus, string>} */
const STATUS_TEXT = {
  open: 'Open',
  filled: 'Filled: payout pending',
  settled: 'Settled: the seller is paid',
  expired: 'Expired: refunds in progress',
  refunded: 'Refunded',
};

/**
 * The element with this id, which must be of `type`.
 *
 * @template {HTMLElement} T
 * @param {string} id
 * @param {{ new (): T }} type
 * @returns {T}
 */
function element(id, type) {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`the page has no suitable #${id}`);
  return found;
}

/**
 * Writes `text` as the text of `target` unless it already holds it. A refresh runs every 2 seconds
 * and most of what it finds is unchanged: writing it anyway would replace the text node under the
 * viewer's selection, and drop the focus from a link that is rewritten.
 *
 * @param {HTMLElement} target
 * @param {string} text
 */
function setText(target, text) {
  if (target.textContent !== text) target.textContent = text;
}

/** The key of what each element last had built into it by `replaceWhenChanged`. */
const builtKeys = new WeakMap();

/**
 * Replaces the children of `parent` with the nodes `build` returns, unless `key`, which stands for
 * everything `build` reads, is the key of the last build into `parent`. An unchanged list keeps its
 * nodes, so a link a viewer is clicking or has focused is not replaced under them.
 *
 * @param {HTMLElement} parent
 * @param {string} key
 * @param {() => Node[]} build
 */
function replaceWhenChanged(parent, key, build) {
  if (builtKeys.get(parent) === key) return;
  builtKeys.set(parent, key);
  parent.replaceChildren(...build());
}

const ui = {
  picker: element('picker', HTMLElement),
  select: element('pool-select', HTMLSelectElement),
  status: element('status', HTMLElement),
  announcement: element('announcement', HTMLElement),
  noPool: element('no-pool', HTMLElement),
  pool: element('pool', HTMLElement),
  poolTitle: element('pool-title', HTMLElement),
  poolStatus: element('pool-status', HTMLElement),
  poolTerms: element('pool-terms', HTMLElement),
  poolBar: element('pool-bar', HTMLProgressElement),
  poolSeats: element('pool-seats', HTMLElement),
  poolPrice: element('pool-price', HTMLElement),
  poolBonus: element('pool-bonus', HTMLElement),
  poolCountdown: element('pool-countdown', HTMLElement),
  poolSeller: element('pool-seller', HTMLElement),
  ledger: element('ledger', HTMLElement),
  paidIn: element('paid-in', HTMLElement),
  paidToSeller: element('paid-to-seller', HTMLElement),
  payoutLinks: element('payout-links', HTMLElement),
  refunded: element('refunded', HTMLElement),
  bonusPaidOut: element('bonus-paid-out', HTMLElement),
  heldNow: element('held-now', HTMLElement),
  contractBalance: element('contract-balance', HTMLElement),
  buyers: element('buyers', HTMLElement),
  buyerRows: element('buyer-rows', HTMLElement),
  noBuyers: element('no-buyers', HTMLElement),
  source: element('source', HTMLElement),
};

/** @type {{ config: PageConfig, token: TokenInfo } | null} */
let setup = null;
/**
 * The pool on screen, which the countdown reads between polls.
 * @type {PoolView | null}
 */
let shown = null;
let polling = false;
/** Whether the last refresh failed, so that the recovery from it is announced. */
let failing = false;
let rpcId = 0;

/**
 * Runs a request, and names it if it is cut short by its timeout. A request aborted by its signal
 * fails with a `TimeoutError` (or an `AbortError`), in the request or while its body is read, and
 * that is reported for the request that timed out, not as an answer that was bad.
 *
 * @template T
 * @param {string} what names the request in the failure
 * @param {() => Promise<T>} send
 * @returns {Promise<T>}
 */
async function timed(what, send) {
  try {
    return await send();
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`${what} timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`);
    }
    throw error;
  }
}

/**
 * GETs a path of the gateway and returns its JSON. Throws unless the answer is a 2xx.
 *
 * @param {string} path
 * @returns {Promise<unknown>}
 */
function getJson(path) {
  return timed(`the request for ${path}`, async () => {
    const response = await fetch(path, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response.json();
  });
}

/**
 * Calls a view through the configured RPC at `block`, and returns what it returned and the hash of
 * the block it was read at. The answer's JSON is read whatever its HTTP status, so that an error the
 * RPC explains is reported by name. A view that times out is reported by its method.
 *
 * @param {PageConfig} config
 * @param {string} accountId
 * @param {string} methodName
 * @param {Record<string, unknown>} args
 * @param {BlockRef} block
 * @returns {Promise<ViewAnswer>}
 */
function view(config, accountId, methodName, args, block) {
  rpcId += 1;
  const id = rpcId;
  return timed(`the ${methodName} view`, async () => {
    const response = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(viewRequest(id, accountId, methodName, args, block)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    /** @type {unknown} */
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`the RPC answered ${response.status} with no JSON`);
      throw error;
    }
    return viewResult(body);
  });
}

/** Reads what the page needs once: the gateway's configuration and the token's decimals. */
async function loadSetup() {
  const config = parseConfig(await getJson('/config.json'));
  const token = parseToken((await view(config, config.token, 'ft_metadata', {}, FINAL)).value);
  setText(ui.source, `Read from the pools contract ${config.poolsContract} on ${config.network}; token ${config.token}.`);
  return { config, token };
}

/**
 * Reads the chain and the feed, then renders the pool the URL asks for, or the provider's newest.
 * What is shown is decided by `poolToShow` from the `get_pool` answer of this refresh: a pool
 * another seller opened is not rendered, and the page shows a notice naming its seller instead.
 * `get_pool` is read at final finality, and the seats and the contract's balance of a pool to render
 * at the block of that answer, so that the three agree. The selector is rendered as soon as the
 * list of pools is read, so that a pool that cannot be read or shown does not hide it. Returns false,
 * rendering no more, when the choice of pool changed while it read.
 *
 * @returns {Promise<boolean>}
 */
async function poll() {
  const search = location.search;
  setup ??= await loadSetup();
  const { config, token } = setup;
  const pools = await readAll(async (from, limit) =>
    parsePoolRefs((await view(config, config.poolsContract, 'list_pools', { from, limit }, FINAL)).value),
  );
  const { options, selected } = poolChoices(pools, config.provider, poolParam(search));
  // Before anything of the pool is read, so that a pool that cannot be shown does not hide the picker.
  if (location.search !== search) return false;
  renderSelector(options, selected);
  const found = selected === null ? null : await view(config, config.poolsContract, 'get_pool', { pool_id: selected }, FINAL);
  const choice = poolToShow(selected, found, config.provider);
  if (choice.kind === 'notice') {
    if (location.search !== search) return false;
    renderNoPool(choice.notice);
    return true;
  }
  const { pool } = choice;
  /** @type {BlockRef} */
  const atPool = { block_id: choice.blockHash };
  const [seats, balance, activity] = await Promise.all([
    readAll(async (from, limit) =>
      parseSeats((await view(config, config.poolsContract, 'get_seats', { pool_id: pool.id, from, limit }, atPool)).value),
    ),
    view(config, config.token, 'ft_balance_of', { account_id: config.poolsContract }, atPool).then((answer) => parseBalance(answer.value)),
    getJson(`/activity?pool=${pool.id}`).then(parseActivity),
  ]);
  if (location.search !== search) return false;
  renderPool(pool, token);
  renderLedger(pool, seats, activity, balance, config, token);
  renderBuyers(pool, seats, activity, config, token);
  return true;
}

/**
 * @param {number[]} options
 * @param {number | null} selected
 */
function renderSelector(options, selected) {
  const key = options.join(',');
  // Rebuilt only when the pools change, so that a list the viewer has open stays open.
  if (ui.select.dataset.options !== key) {
    ui.select.replaceChildren(...options.map((id) => new Option(`Pool ${id}`, String(id))));
    ui.select.dataset.options = key;
  }
  ui.picker.hidden = options.length === 0;
  ui.select.value = selected === null ? '' : String(selected);
}

/** @param {string} message */
function renderNoPool(message) {
  shown = null;
  setText(ui.noPool, message);
  ui.noPool.hidden = false;
  ui.pool.hidden = true;
  ui.ledger.hidden = true;
  ui.buyers.hidden = true;
}

/**
 * @param {PoolView} pool
 * @param {TokenInfo} token
 */
function renderPool(pool, token) {
  shown = pool;
  ui.noPool.hidden = true;
  setText(ui.poolTitle, `Pool ${pool.id}`);
  setText(ui.poolStatus, STATUS_TEXT[pool.status]);
  ui.poolStatus.dataset.status = pool.status;
  setText(ui.poolTerms, pool.terms);
  ui.poolBar.max = pool.target;
  ui.poolBar.value = pool.taken;
  setText(ui.poolSeats, `${pool.taken} of ${pool.target} seats taken`);
  setText(ui.poolPrice, formatAmount(pool.seat_price, token));
  setText(ui.poolBonus, formatAmount(pool.bonus, token));
  const deadline = `Deadline ${new Date(pool.deadline_ms).toLocaleString()}`;
  if (ui.poolCountdown.title !== deadline) ui.poolCountdown.title = deadline;
  setText(ui.poolSeller, pool.seller);
  renderCountdown();
  ui.pool.hidden = false;
}

function renderCountdown() {
  if (shown === null) return;
  setText(ui.poolCountdown, countdownText(shown.status, shown.deadline_ms, Date.now()));
}

/**
 * @param {PoolView} pool
 * @param {SeatView[]} seats
 * @param {ActivityRecord[]} activity
 * @param {string} balance
 * @param {PageConfig} config
 * @param {TokenInfo} token
 */
function renderLedger(pool, seats, activity, balance, config, token) {
  const totals = poolTotals(pool, seats);
  setText(ui.paidIn, formatAmount(totals.paidIn, token));
  setText(ui.paidToSeller, formatAmount(totals.paidToSeller, token));
  const payout = payoutLinks(pool, activity, config.explorerTxUrl);
  replaceWhenChanged(ui.payoutLinks, JSON.stringify(payout), () => linkList(payout));
  setText(ui.refunded, formatAmount(totals.refunded, token));
  setText(ui.bonusPaidOut, formatAmount(totals.bonusPaidOut, token));
  setText(ui.heldNow, formatAmount(totals.heldNow, token));
  setText(ui.contractBalance, formatAmount(balance, token));
  ui.ledger.hidden = false;
}

/**
 * @param {PoolView} pool
 * @param {SeatView[]} seats
 * @param {ActivityRecord[]} activity
 * @param {PageConfig} config
 * @param {TokenInfo} token
 */
function renderBuyers(pool, seats, activity, config, token) {
  const rows = buyerRows(pool, seats, activity, config.explorerTxUrl);
  // The rows hold everything a row shows; the token never changes once read.
  replaceWhenChanged(ui.buyerRows, JSON.stringify(rows), () => rows.map((row) => buyerRow(row, token)));
  ui.noBuyers.hidden = rows.length > 0;
  ui.buyers.hidden = false;
}

/**
 * @param {BuyerRow} row
 * @param {TokenInfo} token
 * @returns {HTMLTableRowElement}
 */
function buyerRow(row, token) {
  const tr = document.createElement('tr');
  const state = row.bonusShare === null ? row.state : `${row.state}, bonus ${formatAmount(row.bonusShare, token)}`;
  tr.append(
    cell(row.buyer, 'account'),
    cell(String(row.seats), 'num'),
    cell(formatAmount(row.paid, token), 'num amount'),
    cell(state, `state state-${row.state}`),
  );
  const links = document.createElement('td');
  links.className = 'links';
  links.append(...linkList(row.links));
  tr.append(links);
  return tr;
}

/**
 * @param {string} text
 * @param {string} className
 * @returns {HTMLTableCellElement}
 */
function cell(text, className) {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = text;
  return td;
}

/**
 * Explorer links, each opening in a new tab.
 *
 * @param {TxLink[]} links
 * @returns {HTMLAnchorElement[]}
 */
function linkList(links) {
  return links.map(({ label, href }) => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  });
}

/**
 * @param {string} text
 * @param {boolean} failed
 */
function showStatus(text, failed) {
  setText(ui.status, text);
  ui.status.classList.toggle('failed', failed);
}

/**
 * Tells a screen reader something, through the live region. The status line is not one, since it is
 * rewritten at every refresh; only a failure and the recovery from one are announced, and the same
 * words twice in a row are not.
 *
 * @param {string} text
 */
function announce(text) {
  setText(ui.announcement, text);
}

/** Runs one poll, unless the previous one is still running, and reports how it went. */
async function tick() {
  if (polling) return;
  polling = true;
  try {
    if (await poll()) {
      showStatus(`Updated at ${new Date().toLocaleTimeString()}`, false);
      if (failing) announce('The page is up to date again.');
      failing = false;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const text = `Could not refresh (${reason}). Retrying every ${POLL_INTERVAL_MS / 1000} seconds.`;
    showStatus(text, true);
    announce(text);
    failing = true;
  } finally {
    polling = false;
  }
}

ui.select.addEventListener('change', () => {
  const url = new URL(location.href);
  url.searchParams.set('pool', ui.select.value);
  history.replaceState(null, '', url);
  showStatus(`Loading pool ${ui.select.value}…`, false);
  void tick();
});

void tick();
setInterval(tick, POLL_INTERVAL_MS);
setInterval(renderCountdown, COUNTDOWN_INTERVAL_MS);
