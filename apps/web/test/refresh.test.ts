import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowedViewCall } from '../../gateway/src/view-call.ts';

/**
 * Runs app.js against a hand-written stand-in for the few parts of the DOM, `fetch` and the timers
 * that it uses, so that what a refresh writes to the page can be checked. Every write to a field
 * that a browser would take as a change (text, a tooltip, the children of an element, a class that
 * flips) is recorded as `<element id>.<property>`.
 */

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const POOLS = 'pools.quorum.testnet';
const TOKEN = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const PROVIDER = 'provider.quorum.testnet';
/** The block the pool list, the token and any other read at final finality is answered from. */
const BLOCK_HASH = 'GZ3Ya1qXp7kN8mWcT4vB9rHfJ2sLdE6uQyKxM5nPaRtV';
/** The block `get_pool` is answered from: not the list's, since the final block moves between two reads. */
const POOL_BLOCK_HASH = 'H7Wq4rN2xY9bKfTe5CmZdPa8vLsJ3uQgR6yXnMhVtB1c';
/** Another seller's account. */
const OTHER_SELLER = 'other-seller.testnet';
const COMMIT_1 = 'Ev64qpcqroBNeET1xax4ei5vDc1sJTyNSZRpj5GdYYTy';
const COMMIT_2 = 'FmHDvha1UrjFE2KZN9NKRTrygpw2iXNsQquSFVHcfGyM';
const SETTLE = '9BAD9UzcJxWNppT8pPBVfpzbu4P9yqgu1nCdnTCYkBjY';
const NOW = 1_800_000_000_000;
/** `GET /demo` while no demo run has been started. */
const DEMO_IDLE = { running: false, scenario: null, startedAt: null, last: null, runsToday: 0, maxRunsPerDay: 100 };

/** What the page wrote, in order. */
let writes: string[] = [];

class FakeElement {
  dataset: Record<string, string> = {};
  hidden: boolean;
  className = '';
  value = '';
  max = 0;
  href = '';
  target = '';
  rel = '';
  children: FakeElement[] = [];
  readonly listeners = new Map<string, () => void>();
  readonly id: string;
  private readonly tracked: boolean;
  private text = '';
  private tip = '';
  private readonly classes = new Set<string>();
  readonly classList = {
    toggle: (name: string, force: boolean): void => {
      if (this.classes.has(name) === force) return;
      this.record(`class.${name}`);
      if (force) this.classes.add(name);
      else this.classes.delete(name);
    },
    contains: (name: string): boolean => this.classes.has(name),
  };

  /** `tracked` is false for an element the page creates, whose writes are of no interest. */
  constructor(id: string, hidden = false, tracked = true) {
    this.id = id;
    this.hidden = hidden;
    this.tracked = tracked;
  }

  private record(property: string): void {
    if (this.tracked) writes.push(`${this.id}.${property}`);
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.record('textContent');
    this.text = value;
  }

  get title(): string {
    return this.tip;
  }

  set title(value: string) {
    this.record('title');
    this.tip = value;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.record('replaceChildren');
    this.children = nodes;
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }
}
class FakeSelect extends FakeElement {}
class FakeProgress extends FakeElement {}
class FakeButton extends FakeElement {
  disabled = false;
}

class FakeOption {
  readonly text: string;
  readonly value: string;

  constructor(text: string, value: string) {
    this.text = text;
    this.value = value;
  }
}

/** The elements of index.html, by id, as the browser would have them before app.js runs. */
function pageElements(): Map<string, FakeElement> {
  const elements = new Map<string, FakeElement>();
  for (const [tag] of html.matchAll(/<[a-z][^>]*\bid="[^"]+"[^>]*>/g)) {
    const id = /\bid="([^"]+)"/.exec(tag)?.[1] ?? '';
    const hidden = /\shidden(\s|>)/.test(tag);
    const type = tag.startsWith('<button') ? FakeButton : id === 'pool-select' ? FakeSelect : id === 'pool-bar' ? FakeProgress : FakeElement;
    elements.set(id, new type(id, hidden));
  }
  return elements;
}

/** An answer of the gateway: its HTTP status and its JSON body. */
interface GatewayAnswer {
  status: number;
  body: unknown;
}

/** The chain and the gateway, as the page reads them. */
interface World {
  pools: Record<string, unknown>[];
  seats: Record<string, unknown>[];
  balance: string;
  activity: Record<string, unknown>[];
  /** The hash of the block `get_pool` is answered from. */
  poolBlockHash: string;
  /** What `/config.json` says of the demo; left out when undefined, as by a gateway without the demo endpoint. */
  demo?: boolean;
  /** The answer to `GET /demo` while the demo is on. */
  demoStatus: GatewayAnswer;
  /** The answer to `POST /demo/<scenario>` while the demo is on. */
  demoAnswer: GatewayAnswer;
  /** Every request the page sent, in order. */
  sent: Sent[];
}

/** A request the page sent, with its JSON body parsed. */
interface Sent {
  url: string;
  method: string;
  body: unknown;
}

/** A view call the page sent through the RPC: what it called, with what, and at which block. */
interface ViewCall {
  method: string;
  args: Record<string, unknown>;
  block: { finality?: string; block_id?: string };
  body: unknown;
}

/** The view calls among `world.sent`, in order. */
function viewCalls(world: World): ViewCall[] {
  return world.sent
    .filter((sent) => sent.url === '/rpc')
    .map(({ body }) => {
      const { params } = body as { params: { method_name: string; args_base64: string; finality?: string; block_id?: string } };
      const block = params.finality === undefined ? { block_id: params.block_id } : { finality: params.finality };
      return { method: params.method_name, args: JSON.parse(atob(params.args_base64)) as Record<string, unknown>, block, body };
    });
}

function openPool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 3,
    seller: PROVIDER,
    seat_price: '180',
    target: 192,
    taken: 2,
    deadline_ms: NOW + 600_000,
    bonus: '1728',
    terms: '8×GPU × 24 h; 1 seat = 1 GPU-hour; prices at 1/10,000 scale',
    status: 'open',
    bonus_per_seat: '0',
    dust_sent: false,
    ...overrides,
  };
}

function commit(account: string, txHash: string): Record<string, unknown> {
  return { at: NOW, poolId: 3, kind: 'commit', account, seats: 1, amount: '180', txHash, ok: true };
}

function newWorld(): World {
  return {
    pools: [openPool()],
    seats: [
      { buyer: 'buyer-01.quorum.testnet', seats: 1, state: 'committed' },
      { buyer: 'buyer-02.quorum.testnet', seats: 1, state: 'committed' },
    ],
    balance: '2088',
    activity: [commit('buyer-01.quorum.testnet', COMMIT_1)],
    poolBlockHash: POOL_BLOCK_HASH,
    demoStatus: { status: 200, body: DEMO_IDLE },
    demoAnswer: { status: 202, body: { scenario: 'fills', startedAt: NOW } },
    sent: [],
  };
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FakeFetch = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<FakeResponse>;

function answering(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** The answer of the pools contract and the token to one view call. */
function viewValue(world: World, method: string, args: Record<string, number | string>): unknown {
  const page = (rows: unknown[]) => rows.slice(Number(args.from), Number(args.from) + Number(args.limit));
  switch (method) {
    case 'ft_metadata':
      return { decimals: 6, symbol: 'USDC' };
    case 'list_pools':
      return page(world.pools);
    case 'get_pool':
      return world.pools.find((pool) => pool.id === args.pool_id) ?? null;
    case 'get_seats':
      return page(world.seats);
    case 'ft_balance_of':
      return world.balance;
    default:
      throw new Error(`no such view: ${method}`);
  }
}

/** The view method an RPC request calls, or undefined for any other request. */
function methodOf(url: string, init?: { body?: string }): string | undefined {
  return url === '/rpc' ? (JSON.parse(init?.body ?? '{}') as { params: { method_name: string } }).params.method_name : undefined;
}

function worldFetch(world: World): FakeFetch {
  return async (url, init) => {
    world.sent.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    if (url === '/config.json') {
      return answering({
        network: 'near:testnet',
        rpcUrl: '/rpc',
        poolsContract: POOLS,
        token: TOKEN,
        provider: PROVIDER,
        explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
        ...(world.demo === undefined ? {} : { demo: world.demo }),
      });
    }
    if (url.startsWith('/activity?pool=')) return answering(world.activity);
    if (url === '/demo' || url === '/demo/fills' || url === '/demo/fails') {
      if (world.demo !== true) return answering({ error: 'not_found' }, 404);
      const { status, body } = url === '/demo' ? world.demoStatus : world.demoAnswer;
      return answering(body, status);
    }
    if (url === '/rpc') {
      const { params, id } = JSON.parse(init?.body ?? '{}') as {
        id: number;
        params: { method_name: string; args_base64: string; block_id?: string };
      };
      const args = JSON.parse(atob(params.args_base64)) as Record<string, number | string>;
      const value = viewValue(world, params.method_name, args);
      const bytes = [...new TextEncoder().encode(JSON.stringify(value))];
      // A read at a block is answered from that block; a read at final finality, from the final block of that moment.
      const blockHash = params.block_id ?? (params.method_name === 'get_pool' ? world.poolBlockHash : BLOCK_HASH);
      return answering({ jsonrpc: '2.0', id, result: { result: bytes, logs: [], block_height: 10, block_hash: blockHash } });
    }
    throw new Error(`unexpected request: ${url}`);
  };
}

let elements = new Map<string, FakeElement>();
let intervals: { run: () => unknown; ms: number }[] = [];
/** The timers the page set with `setTimeout`, which run only when a test runs them. */
let timeouts: { run: () => unknown; ms: number }[] = [];
/** The URLs the page gave `history.replaceState`, in order. */
let replaced: string[] = [];

/** The element with this id. */
function el(id: string): FakeElement {
  const found = elements.get(id);
  if (found === undefined) throw new Error(`no #${id}`);
  return found;
}

/** The button with this id. */
function button(id: string): FakeButton {
  const found = el(id);
  if (!(found instanceof FakeButton)) throw new Error(`#${id} is not a button`);
  return found;
}

/**
 * Waits until the page has handled every answer it has been given and run every refresh that these
 * started: the fake fetch answers within microtasks, which all run before the next macrotask. Unlike
 * `vi.waitFor`, which moves the fake clock at each of its checks, it leaves the clock where it is.
 */
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Loads app.js against `fetch`, with the page at `search`, and waits for its first refresh to finish.
 * `refresh` runs one more, as the 2-second timer would.
 */
async function openPage(fetch: FakeFetch, search = '') {
  elements = pageElements();
  intervals = [];
  timeouts = [];
  replaced = [];
  writes = [];
  vi.resetModules();
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLSelectElement', FakeSelect);
  vi.stubGlobal('HTMLProgressElement', FakeProgress);
  vi.stubGlobal('HTMLButtonElement', FakeButton);
  vi.stubGlobal('Option', FakeOption);
  vi.stubGlobal('document', {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => new FakeElement(tag, false, false),
  });
  vi.stubGlobal('location', { search, href: `http://localhost:8402/${search}` });
  vi.stubGlobal('history', {
    // As in a browser, the URL given becomes the page's URL.
    replaceState: (_state: unknown, _unused: string, url: string | URL) => {
      const next = new URL(url, location.href);
      replaced.push(next.href);
      location.search = next.search;
      location.href = next.href;
    },
  });
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('setInterval', (run: () => unknown, ms: number) => intervals.push({ run, ms }));
  vi.stubGlobal('setTimeout', (run: () => unknown, ms: number) => timeouts.push({ run, ms }));
  await import('../app.js');
  await vi.waitFor(() => expect(el('status').textContent).not.toBe(''));
  const timer = intervals.find((interval) => interval.ms === 2_000);
  if (timer === undefined) throw new Error('app.js sets no 2-second timer');
  return { refresh: async () => void (await timer.run()) };
}

beforeEach(() => {
  // Only the clock is fixed, so that a refresh does not change the time it shows.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The base units of an amount the page shows, `0.002268 USDC` being 2268. */
function baseUnits(shown: string): bigint {
  return BigInt((shown.split(' ')[0] ?? '').replace('.', ''));
}

describe('a refresh', () => {
  it('renders the pool, its buyers and the ledger', async () => {
    await openPage(worldFetch(newWorld()));
    expect(el('pool-title').textContent).toBe('Pool 3');
    expect(el('pool-seats').textContent).toBe('2 of 192 seats taken');
    expect(el('pool-countdown').textContent).toBe('10:00');
    expect(el('buyer-rows').children).toHaveLength(2);
    expect(el('contract-balance').textContent).toBe('0.002088 USDC');
    expect(el('pool').hidden).toBe(false);
  });

  it('writes nothing to the page when nothing has changed, so that focus and a selection survive it', async () => {
    const page = await openPage(worldFetch(newWorld()));
    writes = [];
    await page.refresh();
    expect(writes).toEqual([]);
  });

  it('writes only the field that changed', async () => {
    const world = newWorld();
    const page = await openPage(worldFetch(world));
    writes = [];
    world.balance = '2268';
    await page.refresh();
    expect(writes).toEqual(['contract-balance.textContent']);
  });

  it('rebuilds the buyer rows, and only them, when a buyer commits', async () => {
    const world = newWorld();
    const page = await openPage(worldFetch(world));
    writes = [];
    world.seats.push({ buyer: 'buyer-03.quorum.testnet', seats: 1, state: 'committed' });
    world.pools = [openPool({ taken: 3 })];
    // The third buyer's seat has arrived in the contract's balance.
    world.balance = '2268';
    await page.refresh();
    expect(writes).toEqual([
      'pool-seats.textContent',
      'paid-in.textContent',
      'held-now.textContent',
      'contract-balance.textContent',
      'buyer-rows.replaceChildren',
    ]);
    expect(el('buyer-rows').children).toHaveLength(3);
    // Invariant 1: the contract's balance covers what it holds for the pool.
    expect(baseUnits(el('contract-balance').textContent)).toBeGreaterThanOrEqual(baseUnits(el('held-now').textContent));
  });

  it('builds the buyer rows again at the next refresh when building them threw', async () => {
    const world = newWorld();
    const page = await openPage(worldFetch(world));
    // From now on the page cannot create an element, once.
    const broken = { value: true };
    vi.stubGlobal('document', {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: (tag: string) => {
        if (broken.value) {
          broken.value = false;
          throw new Error('cannot create an element');
        }
        return new FakeElement(tag, false, false);
      },
    });
    world.seats.push({ buyer: 'buyer-03.quorum.testnet', seats: 1, state: 'committed' });
    world.pools = [openPool({ taken: 3 })];
    world.balance = '2268';
    await page.refresh();
    expect(el('status').textContent).toBe('Could not refresh (cannot create an element). Retrying every 2 seconds.');
    expect(el('buyer-rows').children.length).toBe(2);
    await page.refresh();
    expect(el('status').textContent).toMatch(/^Updated at /);
    expect(el('buyer-rows').children.length).toBe(3);
  });

  it("rebuilds a buyer's links when its commit shows in the feed", async () => {
    const world = newWorld();
    const page = await openPage(worldFetch(world));
    writes = [];
    world.activity.push(commit('buyer-02.quorum.testnet', COMMIT_2));
    await page.refresh();
    expect(writes).toEqual(['buyer-rows.replaceChildren']);
  });

  it("rebuilds the payout links when the pool's settlement shows in the feed", async () => {
    const world = newWorld();
    const page = await openPage(worldFetch(world));
    writes = [];
    world.activity.push({ ...commit(PROVIDER, SETTLE), kind: 'settle' });
    await page.refresh();
    expect(writes).toEqual(['payout-links.replaceChildren']);
  });
});

describe('the reads of a refresh', () => {
  const only = (world: World, method: string) => viewCalls(world).filter((call) => call.method === method);

  it('reads the pool list, the pool and the token at final finality, and its seats and the balance at the block of the pool', async () => {
    const world = newWorld();
    const page = await openPage(worldFetch(world));
    for (const method of ['list_pools', 'get_pool', 'ft_metadata']) {
      expect(only(world, method).length, method).toBeGreaterThan(0);
      for (const call of only(world, method)) expect(call.block, method).toEqual({ finality: 'final' });
    }
    for (const method of ['get_seats', 'ft_balance_of']) {
      expect(only(world, method).length, method).toBeGreaterThan(0);
      for (const call of only(world, method)) expect(call.block, method).toEqual({ block_id: POOL_BLOCK_HASH });
    }
    // Each refresh reads at the block of its own get_pool answer, not at one it kept.
    const next = 'Dq6Jr2WzKx9nPaYhT4mVbN8cSfE3uLgHyR5tXMeCvB7k';
    world.poolBlockHash = next;
    world.sent.length = 0;
    await page.refresh();
    for (const method of ['get_seats', 'ft_balance_of']) {
      expect(only(world, method).length, method).toBeGreaterThan(0);
      for (const call of only(world, method)) expect(call.block, method).toEqual({ block_id: next });
    }
  });

  it("sends the pass-through only bodies it forwards, and the gateway only the two requests it serves the page while its demo is off, showing no demo controls", async () => {
    // A gateway without the demo endpoint sends no `demo`; one with the endpoint off sends false.
    for (const demo of [undefined, false]) {
      const world = { ...newWorld(), demo };
      const page = await openPage(worldFetch(world));
      await page.refresh();
      const rpc = world.sent.filter((sent) => sent.url === '/rpc');
      expect(rpc.length).toBeGreaterThan(0);
      for (const { body, method } of rpc) {
        expect(method).toBe('POST');
        expect(isAllowedViewCall(JSON.parse(JSON.stringify(body)), [POOLS, TOKEN]), JSON.stringify(body)).toBe(true);
      }
      const gateway = world.sent.filter((sent) => sent.url !== '/rpc');
      expect(gateway.every((sent) => sent.method === 'GET')).toBe(true);
      expect(new Set(gateway.map((sent) => sent.url)), `demo: ${demo}`).toEqual(new Set(['/config.json', '/activity?pool=3']));
      expect(el('demo').hidden, `demo: ${demo}`).toBe(true);
    }
  });
});

describe('a pool another seller opened', () => {
  const NOTICE = `Pool 4 was opened by ${OTHER_SELLER}, not by this gateway's provider ${PROVIDER}: this page shows only the provider's pools.`;
  const withForeignPool = () => {
    const world = newWorld();
    world.pools.push(openPool({ id: 4, seller: OTHER_SELLER }));
    return world;
  };
  /** The requests that read a pool's seats, the contract's balance or the pool's feed. */
  const dataReads = (world: World) => [
    ...viewCalls(world).filter((call) => call.method === 'get_seats' || call.method === 'ft_balance_of'),
    ...world.sent.filter((sent) => sent.url.startsWith('/activity')),
  ];

  it('shows the notice in place of the card, the ledger and the buyers, and makes none of the requests for their data', async () => {
    const world = withForeignPool();
    const page = await openPage(worldFetch(world));
    expect(el('pool').hidden).toBe(false);
    expect(el('ledger').hidden).toBe(false);
    expect(el('buyers').hidden).toBe(false);
    location.search = '?pool=4';
    world.sent.length = 0;
    await page.refresh();
    expect(el('no-pool').textContent).toBe(NOTICE);
    expect(el('no-pool').hidden).toBe(false);
    expect(el('pool').hidden).toBe(true);
    expect(el('ledger').hidden).toBe(true);
    expect(el('buyers').hidden).toBe(true);
    expect(viewCalls(world).map((call) => call.method)).toEqual(['list_pools', 'get_pool']);
    expect(dataReads(world)).toEqual([]);
  });

  it('shows the notice, and makes none of those requests, when the page is opened on the pool', async () => {
    const world = withForeignPool();
    await openPage(worldFetch(world), '?pool=4');
    expect(el('no-pool').textContent).toBe(NOTICE);
    expect(el('pool').hidden).toBe(true);
    expect(el('ledger').hidden).toBe(true);
    expect(el('buyers').hidden).toBe(true);
    expect(dataReads(world)).toEqual([]);
    expect(el('pool-select').children.map((option) => (option as unknown as { value: string }).value)).toEqual(['3']);
  });
});

describe('a change of pool while a refresh reads', () => {
  it.each(['get_seats', 'ft_balance_of', '/activity?pool=3'])('renders nothing of the old pool when the URL changes during %s', async (inFlight) => {
    const world = newWorld();
    world.pools.push(openPool({ id: 4, taken: 1 }));
    const base = worldFetch(world);
    const hooks = { onRequest: (_what: string) => {} };
    const page = await openPage(async (url, init) => {
      hooks.onRequest(methodOf(url, init) ?? url);
      return base(url, init);
    }, '?pool=3');
    // Everything shown of pool 3 has changed since, so that a refresh that rendered it would write.
    world.seats.push({ buyer: 'buyer-03.quorum.testnet', seats: 1, state: 'committed' });
    world.pools[0] = openPool({ taken: 3 });
    world.balance = '2268';
    hooks.onRequest = (what) => {
      if (what === inFlight) location.search = '?pool=4';
    };
    writes = [];
    await page.refresh();
    expect(writes).toEqual([]);
    expect(el('pool-title').textContent).toBe('Pool 3');
    // The next refresh shows the pool the viewer chose.
    hooks.onRequest = () => {};
    await page.refresh();
    expect(el('pool-title').textContent).toBe('Pool 4');
  });
});

describe('a change of pool while a refresh reads a pool another seller opened', () => {
  it('shows no notice for a pool the viewer has left', async () => {
    const world = newWorld();
    world.pools.push(openPool({ id: 4, seller: OTHER_SELLER }));
    const base = worldFetch(world);
    const hooks = { onRequest: (_what: string) => {} };
    const page = await openPage(async (url, init) => {
      hooks.onRequest(methodOf(url, init) ?? url);
      return base(url, init);
    }, '?pool=3');
    location.search = '?pool=4';
    hooks.onRequest = (what) => {
      if (what === 'get_pool') location.search = '?pool=3';
    };
    writes = [];
    await page.refresh();
    expect(writes).toEqual([]);
    expect(el('no-pool').hidden).toBe(true);
    expect(el('pool-title').textContent).toBe('Pool 3');
  });
});

describe('the status line', () => {
  /** A fetch that answers from `world` until `down.value` is set, then fails as a network error does. */
  function flaky(world: World) {
    const down = { value: false };
    const base = worldFetch(world);
    const fetch: FakeFetch = (url, init) => (down.value ? Promise.reject(new Error('offline')) : base(url, init));
    return { down, fetch };
  }

  it('shows when the page was updated, and says nothing to a screen reader about it', async () => {
    const page = await openPage(worldFetch(newWorld()));
    await page.refresh();
    expect(el('status').textContent).toMatch(/^Updated at /);
    expect(writes.filter((write) => write.startsWith('announcement.'))).toEqual([]);
  });

  it('shows a failed refresh with its reason, and announces it once however long it lasts', async () => {
    const { down, fetch } = flaky(newWorld());
    const page = await openPage(fetch);
    down.value = true;
    await page.refresh();
    expect(el('status').textContent).toBe('Could not refresh (offline). Retrying every 2 seconds.');
    expect(el('status').classList.contains('failed')).toBe(true);
    expect(el('announcement').textContent).toBe('Could not refresh (offline). Retrying every 2 seconds.');
    writes = [];
    await page.refresh();
    await page.refresh();
    expect(writes.filter((write) => write.startsWith('announcement.'))).toEqual([]);
  });

  it('announces the recovery from a failure, once', async () => {
    const { down, fetch } = flaky(newWorld());
    const page = await openPage(fetch);
    down.value = true;
    await page.refresh();
    down.value = false;
    writes = [];
    await page.refresh();
    expect(el('status').textContent).toMatch(/^Updated at /);
    expect(el('announcement').textContent).toBe('The page is up to date again.');
    expect(writes.filter((write) => write.startsWith('announcement.'))).toEqual(['announcement.textContent']);
    writes = [];
    await page.refresh();
    expect(writes.filter((write) => write.startsWith('announcement.'))).toEqual([]);
  });

  it('announces a failure again after a recovery', async () => {
    const { down, fetch } = flaky(newWorld());
    const page = await openPage(fetch);
    down.value = true;
    await page.refresh();
    down.value = false;
    await page.refresh();
    down.value = true;
    writes = [];
    await page.refresh();
    expect(el('announcement').textContent).toBe('Could not refresh (offline). Retrying every 2 seconds.');
    expect(writes.filter((write) => write.startsWith('announcement.'))).toEqual(['announcement.textContent']);
  });

  it('announces nothing while a pool is chosen from the selector', async () => {
    await openPage(worldFetch(newWorld()));
    writes = [];
    el('pool-select').value = '3';
    el('pool-select').listeners.get('change')?.();
    expect(el('status').textContent).toBe('Loading pool 3…');
    await vi.waitFor(() => expect(el('status').textContent).toMatch(/^Updated at /));
    expect(writes.filter((write) => write.startsWith('announcement.'))).toEqual([]);
  });
});

describe('a failure while the viewer leaves the pool', () => {
  /**
   * A fetch that fails every request while `down.value` is set, and, once `leave.armed` is set,
   * moves the page to pool 4 and fails the first `get_seats`: the viewer chose another pool while
   * the seats of pool 3 were read, and that read failed.
   */
  function leaving(world: World) {
    const down = { value: false };
    const leave = { armed: false };
    const base = worldFetch(world);
    const fetch: FakeFetch = async (url, init) => {
      if (down.value) throw new Error('offline');
      if (leave.armed && methodOf(url, init) === 'get_seats') {
        leave.armed = false;
        location.search = '?pool=4';
        throw new Error('overloaded');
      }
      return base(url, init);
    };
    return { down, leave, fetch };
  }
  const announcements = () => writes.filter((write) => write.startsWith('announcement.'));
  const twoPools = () => {
    const world = newWorld();
    world.pools.push(openPool({ id: 4 }));
    return world;
  };

  it('shows and announces nothing of it, and the next refresh shows the pool the viewer chose', async () => {
    const { leave, fetch } = leaving(twoPools());
    const page = await openPage(fetch, '?pool=3');
    leave.armed = true;
    writes = [];
    await page.refresh();
    expect(writes).toEqual([]);
    expect(el('status').textContent).toMatch(/^Updated at /);
    expect(el('status').classList.contains('failed')).toBe(false);
    await page.refresh();
    expect(el('pool-title').textContent).toBe('Pool 4');
    expect(el('status').textContent).toMatch(/^Updated at /);
    expect(announcements()).toEqual([]);
  });

  it('leaves a failure that stands as it was, so that the recovery from it is still announced', async () => {
    const { down, leave, fetch } = leaving(twoPools());
    const page = await openPage(fetch, '?pool=3');
    down.value = true;
    await page.refresh();
    expect(el('status').textContent).toBe('Could not refresh (offline). Retrying every 2 seconds.');
    down.value = false;
    leave.armed = true;
    writes = [];
    await page.refresh();
    expect(writes).toEqual([]);
    expect(el('status').textContent).toBe('Could not refresh (offline). Retrying every 2 seconds.');
    await page.refresh();
    expect(el('status').textContent).toMatch(/^Updated at /);
    expect(el('announcement').textContent).toBe('The page is up to date again.');
  });
});

describe('a request that fails', () => {
  /** The request that `fail` makes fail, and how: before the answer, or while reading its body. */
  type Failure = { when: (url: string, method: string | undefined) => boolean; at: 'fetch' | 'body'; error: Error };

  function failing(world: World, { when, at, error }: Failure): FakeFetch {
    const base = worldFetch(world);
    return async (url, init) => {
      if (!when(url, methodOf(url, init))) return base(url, init);
      if (at === 'fetch') throw error;
      return { ok: true, status: 200, json: () => Promise.reject(error) };
    };
  }

  const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const abort = () => new DOMException('This operation was aborted', 'AbortError');

  it.each([
    ['a view the RPC does not answer in time', (_url: string, method?: string) => method === 'list_pools', 'the list_pools view timed out after 10 seconds'],
    ['the token metadata', (_url: string, method?: string) => method === 'ft_metadata', 'the ft_metadata view timed out after 10 seconds'],
    ['the configuration', (url: string) => url === '/config.json', 'the request for /config.json timed out after 10 seconds'],
    ['the activity feed', (url: string) => url.startsWith('/activity'), 'the request for /activity?pool=3 timed out after 10 seconds'],
  ])('names %s when it times out', async (_what, when, reason) => {
    for (const make of [timeout, abort]) {
      for (const at of ['fetch', 'body'] as const) {
        // The configuration and the feed are read as JSON by the same path whether the failure is in the request or the body.
        const page = await openPage(failing(newWorld(), { when, at, error: make() }));
        await page.refresh();
        expect(el('status').textContent, `${make.name} ${at}`).toBe(`Could not refresh (${reason}). Retrying every 2 seconds.`);
      }
    }
  });

  it('reports an RPC answer that is not JSON as one, with its status', async () => {
    const world = newWorld();
    const base = worldFetch(world);
    const page = await openPage(async (url, init) =>
      url === '/rpc' ? { ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')) } : base(url, init),
    );
    expect(el('status').textContent).toBe('Could not refresh (the RPC answered 200 with no JSON). Retrying every 2 seconds.');
    await page.refresh();
    expect(el('status').classList.contains('failed')).toBe(true);
  });

  it('reports any other failure to read an RPC answer as it is, not as a missing JSON', async () => {
    const world = newWorld();
    const base = worldFetch(world);
    await openPage(async (url, init) =>
      url === '/rpc' ? { ok: true, status: 200, json: () => Promise.reject(new TypeError('network error')) } : base(url, init),
    );
    expect(el('status').textContent).toBe('Could not refresh (network error). Retrying every 2 seconds.');
  });
});

describe('the pool selector', () => {
  it("lists the provider's pools even when the pool to show is malformed", async () => {
    const world = newWorld();
    world.pools = [openPool({ id: 2 }), openPool({ id: 3, terms: 42 })];
    await openPage(worldFetch(world));
    expect(el('status').textContent).toBe('Could not refresh (the pools contract returned a malformed pool). Retrying every 2 seconds.');
    expect(el('picker').hidden).toBe(false);
    expect(el('pool-select').children.map((option) => (option as unknown as { value: string }).value)).toEqual(['3', '2']);
    expect(el('pool-select').value).toBe('3');
  });

  it('is left as it was when the URL changed while the pools were read', async () => {
    const world = newWorld();
    const base = worldFetch(world);
    const hooks = { onListPools: () => {} };
    const page = await openPage(async (url, init) => {
      if (methodOf(url, init) === 'list_pools') hooks.onListPools();
      return base(url, init);
    });
    world.pools.push(openPool({ id: 4 }));
    hooks.onListPools = () => {
      location.search = '?pool=2';
    };
    writes = [];
    await page.refresh();
    expect(writes).toEqual([]);
    expect(el('pool-select').children).toHaveLength(1);
  });
});

describe('the demo controls', () => {
  /** A world whose gateway has its demo on. */
  const demoWorld = (): World => ({ ...newWorld(), demo: true });
  const STARTED = 'A run started. Its pool appears here once it opens.';

  it('are shown when /config.json says demo: true, with the buttons enabled and a line inviting a first run, and GET /demo is read at every refresh', async () => {
    const world = demoWorld();
    const page = await openPage(worldFetch(world));
    expect(el('demo').hidden).toBe(false);
    expect(el('demo-line').textContent).toBe('Start a run to watch a pool from its first seat.');
    expect(button('demo-fills').disabled).toBe(false);
    expect(button('demo-fails').disabled).toBe(false);
    await page.refresh();
    expect(world.sent.filter((sent) => sent.url === '/demo').map((sent) => sent.method)).toEqual(['GET', 'GET']);
  });

  it('write nothing to the page at a refresh where nothing has changed', async () => {
    const page = await openPage(worldFetch(demoWorld()));
    writes = [];
    await page.refresh();
    expect(writes).toEqual([]);
  });

  it.each([
    [
      'a run is in progress',
      { status: 200, body: { ...DEMO_IDLE, running: true, scenario: 'fails', startedAt: NOW - 90_000, runsToday: 1 } },
      `A fails run started at ${new Date(NOW - 90_000).toLocaleTimeString()} is in progress.`,
    ],
    ["today's cap is reached", { status: 200, body: { ...DEMO_IDLE, runsToday: 100 } }, 'The demo has reached its limit for today.'],
    ['GET /demo fails', { status: 502, body: null }, "The demo's status is unavailable."],
    ['GET /demo answers a malformed status', { status: 200, body: { ...DEMO_IDLE, running: 'no' } }, "The demo's status is unavailable."],
  ])('stay shown with the buttons disabled when %s, and say so on the demo line, not on the status line', async (_kind, demoStatus, line) => {
    await openPage(worldFetch({ ...demoWorld(), demoStatus }));
    expect(el('demo').hidden).toBe(false);
    expect(button('demo-fills').disabled).toBe(true);
    expect(button('demo-fails').disabled).toBe(true);
    expect(el('demo-line').textContent).toBe(line);
    expect(el('status').textContent).toMatch(/^Updated at /);
    expect(el('status').classList.contains('failed')).toBe(false);
  });

  it.each([
    ['demo-fills', 'fills'],
    ['demo-fails', 'fails'],
  ])('send, on a click on #%s, POST /demo/%s with the header X-Quorum-Demo: 1, after removing ?pool= from the URL, and keep both buttons disabled from then until a GET /demo reports no run in progress', async (id, scenario) => {
    const world: World = { ...demoWorld(), demoAnswer: { status: 202, body: { scenario, startedAt: NOW } } };
    const base = worldFetch(world);
    /** The demo requests, each with the page's URL when it was sent. */
    const posts: { url: string; method?: string; headers?: Record<string, string>; href: string }[] = [];
    let answer = (): void => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const page = await openPage(async (url, init) => {
      if (url.startsWith('/demo/')) {
        posts.push({ url, method: init?.method, headers: init?.headers, href: location.href });
        await answered;
      }
      return base(url, init);
    }, '?pool=3');
    el(id).listeners.get('click')?.();
    // From the click on, GET /demo answers the run it started, as the gateway does.
    world.demoStatus = { status: 200, body: { ...DEMO_IDLE, running: true, scenario, startedAt: NOW, runsToday: 1 } };
    expect(replaced).toEqual(['http://localhost:8402/']);
    expect(posts).toEqual([{ url: `/demo/${scenario}`, method: 'POST', headers: { 'X-Quorum-Demo': '1' }, href: 'http://localhost:8402/' }]);
    expect(button('demo-fills').disabled).toBe(true);
    expect(button('demo-fails').disabled).toBe(true);
    answer();
    await settled();
    expect(el('demo-line').textContent).toBe(STARTED);
    expect(button('demo-fills').disabled).toBe(true);
    expect(button('demo-fails').disabled).toBe(true);
    // The run ends, and the next refresh's GET /demo says so.
    world.demoStatus = {
      status: 200,
      body: { ...DEMO_IDLE, last: { scenario, startedAt: NOW, endedAt: NOW, exitCode: 0, signal: null }, runsToday: 1 },
    };
    await page.refresh();
    expect(button('demo-fills').disabled).toBe(false);
    expect(button('demo-fails').disabled).toBe(false);
    expect(posts).toHaveLength(1);
  });

  it.each([
    ['202', { status: 202, body: { scenario: 'fills', startedAt: NOW } }, STARTED, 'fills', NOW],
    [
      '409 demo_running',
      { status: 409, body: { error: 'demo_running', scenario: 'fails', startedAt: NOW - 60_000 } },
      'A run is already in progress. This page follows its pool once it opens.',
      'fails',
      NOW - 60_000,
    ],
  ])(
    'keep both buttons disabled after a click answered %s during a refresh, whose GET /demo, sent before the answer, cannot enable them again',
    async (_kind, demoAnswer, answerLine, scenario, startedAt) => {
      const world: World = { ...demoWorld(), demoAnswer };
      const base = worldFetch(world);
      const hold = { on: false, release: (): void => {} };
      const page = await openPage(async (url, init) => {
        if (url !== '/demo' || !hold.on) return base(url, init);
        // Answered as the gateway stood when it was sent, before the click, but delivered only on release.
        const answer = base(url, init);
        await new Promise<void>((resolve) => {
          hold.release = resolve;
        });
        return answer;
      });
      hold.on = true;
      const inFlight = page.refresh();
      await settled();
      hold.on = false;
      el('demo-fills').listeners.get('click')?.();
      await settled();
      const arrived = Date.now();
      expect(el('demo-line').textContent).toBe(answerLine);
      expect(button('demo-fills').disabled).toBe(true);
      expect(button('demo-fails').disabled).toBe(true);
      // The refresh's GET /demo arrives after the answer, saying that no run is in progress.
      hold.release();
      await inFlight;
      await settled();
      expect(button('demo-fills').disabled).toBe(true);
      expect(button('demo-fails').disabled).toBe(true);
      // Once the answer's 10 seconds are over, the demo line names the run the answer reported.
      const timer = timeouts.find((timeout) => timeout.ms === 10_000);
      if (timer === undefined) throw new Error('app.js sets no 10-second timer after the answer');
      vi.setSystemTime(arrived + 10_000);
      timer.run();
      expect(el('demo-line').textContent).toBe(`A ${scenario} run started at ${new Date(startedAt).toLocaleTimeString()} is in progress.`);
      // A GET /demo sent after the answer reports that the run has ended.
      world.demoStatus = {
        status: 200,
        body: { ...DEMO_IDLE, last: { scenario, startedAt, endedAt: arrived + 10_000, exitCode: 0, signal: null }, runsToday: 1 },
      };
      await page.refresh();
      expect(button('demo-fills').disabled).toBe(false);
      expect(button('demo-fails').disabled).toBe(false);
    },
  );

  it("show the click's answer on the demo line for 10 seconds from when it arrived, then what GET /demo says", async () => {
    const world = demoWorld();
    const base = worldFetch(world);
    let answer = (): void => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await openPage(async (url, init) => {
      if (url.startsWith('/demo/')) await answered;
      return base(url, init);
    });
    // From the click on, GET /demo answers the run it started.
    const running = { ...DEMO_IDLE, running: true, scenario: 'fills', startedAt: Date.now(), runsToday: 1 };
    world.demoStatus = { status: 200, body: running };
    el('demo-fills').listeners.get('click')?.();
    // The answer arrives 3 seconds after the click.
    const arrived = Date.now() + 3_000;
    vi.setSystemTime(arrived);
    answer();
    await settled();
    expect(el('demo-line').textContent).toBe(STARTED);
    // The refresh that follows the answer reads the run in progress, which disables the buttons.
    expect(button('demo-fills').disabled).toBe(true);
    const timer = timeouts.find((timeout) => timeout.ms === 10_000);
    if (timer === undefined) throw new Error('app.js sets no 10-second timer after the answer');
    vi.setSystemTime(arrived + 9_999);
    timer.run();
    expect(el('demo-line').textContent).toBe(STARTED);
    vi.setSystemTime(arrived + 10_000);
    timer.run();
    expect(el('demo-line').textContent).toBe(`A fills run started at ${new Date(running.startedAt).toLocaleTimeString()} is in progress.`);
  });

  it.each([
    ['gets no answer', () => Promise.reject(new TypeError('Failed to fetch')), 'The gateway could not be reached.'],
    [
      'gets an answer with no JSON body',
      () => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }),
      'The demo is not available right now.',
    ],
  ])('say so on the demo line when a click %s, and enable the buttons again', async (_kind, post, line) => {
    const base = worldFetch(demoWorld());
    await openPage((url, init) => (url.startsWith('/demo/') ? post() : base(url, init)));
    el('demo-fails').listeners.get('click')?.();
    await settled();
    expect(el('demo-line').textContent).toBe(line);
    expect(button('demo-fills').disabled).toBe(false);
    expect(button('demo-fails').disabled).toBe(false);
    expect(el('status').textContent).toMatch(/^Updated at /);
  });

  it('make the page follow the newest pool after a click, which is the pool the run opens', async () => {
    const world = demoWorld();
    world.pools = [openPool({ id: 2, status: 'settled' }), openPool({ id: 3, status: 'settled' })];
    const page = await openPage(worldFetch(world), '?pool=2');
    expect(el('pool-title').textContent).toBe('Pool 2');
    el('demo-fills').listeners.get('click')?.();
    await settled();
    expect(el('pool-title').textContent).toBe('Pool 3');
    // The run opens its pool.
    world.pools.push(openPool({ id: 4 }));
    await page.refresh();
    expect(el('pool-title').textContent).toBe('Pool 4');
  });
});
