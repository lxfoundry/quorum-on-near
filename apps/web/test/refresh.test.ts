import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const BLOCK_HASH = 'GZ3Ya1qXp7kN8mWcT4vB9rHfJ2sLdE6uQyKxM5nPaRtV';
const COMMIT_1 = 'Ev64qpcqroBNeET1xax4ei5vDc1sJTyNSZRpj5GdYYTy';
const COMMIT_2 = 'FmHDvha1UrjFE2KZN9NKRTrygpw2iXNsQquSFVHcfGyM';
const SETTLE = '9BAD9UzcJxWNppT8pPBVfpzbu4P9yqgu1nCdnTCYkBjY';
const NOW = 1_800_000_000_000;

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
    elements.set(id, id === 'pool-select' ? new FakeSelect(id, hidden) : id === 'pool-bar' ? new FakeProgress(id, hidden) : new FakeElement(id, hidden));
  }
  return elements;
}

/** The chain and the gateway, as the page reads them. */
interface World {
  pools: Record<string, unknown>[];
  seats: Record<string, unknown>[];
  balance: string;
  activity: Record<string, unknown>[];
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
  };
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FakeFetch = (url: string, init?: { method?: string; body?: string }) => Promise<FakeResponse>;

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

function worldFetch(world: World): FakeFetch {
  return async (url, init) => {
    if (url === '/config.json') {
      return answering({
        network: 'near:testnet',
        rpcUrl: '/rpc',
        poolsContract: POOLS,
        token: TOKEN,
        provider: PROVIDER,
        explorerTxUrl: 'https://testnet.nearblocks.io/txns/',
      });
    }
    if (url.startsWith('/activity?pool=')) return answering(world.activity);
    if (url === '/rpc') {
      const { params, id } = JSON.parse(init?.body ?? '{}') as { id: number; params: { method_name: string; args_base64: string } };
      const args = JSON.parse(atob(params.args_base64)) as Record<string, number | string>;
      const value = viewValue(world, params.method_name, args);
      const bytes = [...new TextEncoder().encode(JSON.stringify(value))];
      return answering({ jsonrpc: '2.0', id, result: { result: bytes, logs: [], block_height: 10, block_hash: BLOCK_HASH } });
    }
    throw new Error(`unexpected request: ${url}`);
  };
}

let elements = new Map<string, FakeElement>();
let intervals: { run: () => unknown; ms: number }[] = [];

/** The element with this id. */
function el(id: string): FakeElement {
  const found = elements.get(id);
  if (found === undefined) throw new Error(`no #${id}`);
  return found;
}

/**
 * Loads app.js against `fetch`, with the page at `search`, and waits for its first refresh to finish.
 * `refresh` runs one more, as the 2-second timer would.
 */
async function openPage(fetch: FakeFetch, search = '') {
  elements = pageElements();
  intervals = [];
  writes = [];
  vi.resetModules();
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLSelectElement', FakeSelect);
  vi.stubGlobal('HTMLProgressElement', FakeProgress);
  vi.stubGlobal('Option', FakeOption);
  vi.stubGlobal('document', {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => new FakeElement(tag, false, false),
  });
  vi.stubGlobal('location', { search, href: `http://localhost:8402/${search}` });
  vi.stubGlobal('history', { replaceState: () => undefined });
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('setInterval', (run: () => unknown, ms: number) => intervals.push({ run, ms }));
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
    await page.refresh();
    expect(writes).toEqual(['pool-seats.textContent', 'paid-in.textContent', 'held-now.textContent', 'buyer-rows.replaceChildren']);
    expect(el('buyer-rows').children).toHaveLength(3);
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
