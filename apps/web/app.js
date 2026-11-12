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

const ui = {
  picker: element('picker', HTMLElement),
  select: element('pool-select', HTMLSelectElement),
  status: element('status', HTMLElement),
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
let rpcId = 0;

/**
 * GETs a path of the gateway and returns its JSON. Throws unless the answer is a 2xx.
 *
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function getJson(path) {
  const response = await fetch(path, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

/**
 * Calls a view through the configured RPC at `block`, and returns what it returned and the hash of
 * the block it was read at. The answer's JSON is read whatever its HTTP status, so that an error the
 * RPC explains is reported by name.
 *
 * @param {PageConfig} config
 * @param {string} accountId
 * @param {string} methodName
 * @param {Record<string, unknown>} args
 * @param {BlockRef} block
 * @returns {Promise<ViewAnswer>}
 */
async function view(config, accountId, methodName, args, block) {
  rpcId += 1;
  const response = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(viewRequest(rpcId, accountId, methodName, args, block)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  /** @type {unknown} */
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`the RPC answered ${response.status} with no JSON`);
  }
  return viewResult(body);
}

/** Reads what the page needs once: the gateway's configuration and the token's decimals. */
async function loadSetup() {
  const config = parseConfig(await getJson('/config.json'));
  const token = parseToken((await view(config, config.token, 'ft_metadata', {}, FINAL)).value);
  ui.source.textContent = `Read from the pools contract ${config.poolsContract} on ${config.network}; token ${config.token}.`;
  return { config, token };
}

/**
 * Reads the chain and the feed, then renders the pool the URL asks for, or the provider's newest.
 * What is shown is decided by `poolToShow` from the `get_pool` answer of this refresh: a pool
 * another seller opened is not rendered, and the page shows a notice naming its seller instead.
 * `get_pool` is read at final finality, and the seats and the contract's balance of a pool to render
 * at the block of that answer, so that the three agree. Returns false, rendering nothing, when the
 * choice of pool changed while it read.
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
  const found = selected === null ? null : await view(config, config.poolsContract, 'get_pool', { pool_id: selected }, FINAL);
  const choice = poolToShow(selected, found, config.provider);
  if (choice.kind === 'notice') {
    if (location.search !== search) return false;
    renderSelector(options, selected);
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
  renderSelector(options, selected);
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
  ui.noPool.textContent = message;
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
  ui.poolTitle.textContent = `Pool ${pool.id}`;
  ui.poolStatus.textContent = STATUS_TEXT[pool.status];
  ui.poolStatus.dataset.status = pool.status;
  ui.poolTerms.textContent = pool.terms;
  ui.poolBar.max = pool.target;
  ui.poolBar.value = pool.taken;
  ui.poolSeats.textContent = `${pool.taken} of ${pool.target} seats taken`;
  ui.poolPrice.textContent = formatAmount(pool.seat_price, token);
  ui.poolBonus.textContent = formatAmount(pool.bonus, token);
  ui.poolCountdown.title = `Deadline ${new Date(pool.deadline_ms).toLocaleString()}`;
  ui.poolSeller.textContent = pool.seller;
  renderCountdown();
  ui.pool.hidden = false;
}

function renderCountdown() {
  if (shown === null) return;
  ui.poolCountdown.textContent = countdownText(shown.status, shown.deadline_ms, Date.now());
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
  ui.paidIn.textContent = formatAmount(totals.paidIn, token);
  ui.paidToSeller.textContent = formatAmount(totals.paidToSeller, token);
  ui.payoutLinks.replaceChildren(...linkList(payoutLinks(pool, activity, config.explorerTxUrl)));
  ui.refunded.textContent = formatAmount(totals.refunded, token);
  ui.bonusPaidOut.textContent = formatAmount(totals.bonusPaidOut, token);
  ui.heldNow.textContent = formatAmount(totals.heldNow, token);
  ui.contractBalance.textContent = formatAmount(balance, token);
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
  ui.buyerRows.replaceChildren(...rows.map((row) => buyerRow(row, token)));
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
  ui.status.textContent = text;
  ui.status.classList.toggle('failed', failed);
}

/** Runs one poll, unless the previous one is still running, and reports how it went. */
async function tick() {
  if (polling) return;
  polling = true;
  try {
    if (await poll()) showStatus(`Updated at ${new Date().toLocaleTimeString()}`, false);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    showStatus(`Could not refresh (${reason}). Retrying every ${POLL_INTERVAL_MS / 1000} seconds.`, true);
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
