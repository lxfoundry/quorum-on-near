import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { writeSpendFile } from '@quorum-on-near/buyer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server.ts';
import {
  BUYER,
  CREDENTIAL,
  filled,
  LISTING,
  POOL,
  RPC_URL,
  signed,
  TERMS,
  toolDeps,
  TX_HASH,
  type Answers,
  type Calls,
} from './fixtures.ts';

let dir: string;
const closing: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-mcp-server-'));
});

afterEach(async () => {
  for (const close of closing.splice(0)) await close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * A client connected in memory to the server over stubbed dependencies. The tool list is read first,
 * so that the client also checks each result against its tool's output schema, as JSON Schema.
 */
async function connect(answers?: Answers): Promise<{ client: Client; calls: Calls; logs: string[] }> {
  const { deps, calls, logs } = toolDeps(join(dir, 'mcp-spend.json'), answers);
  const server = buildServer(deps);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closing.push(
    () => client.close(),
    () => server.close(),
  );
  await client.listTools();
  return { client, calls, logs };
}

/** callTool's declared result also admits a legacy shape; parsing narrows it. */
async function call(client: Client, name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await client.callTool({ name, ...(args === undefined ? {} : { arguments: args }) }));
}

function text(result: CallToolResult): string {
  const [block] = result.content;
  if (block?.type !== 'text' || result.content.length !== 1) throw new Error('expected one text block');
  return block.text;
}

describe('buildServer', () => {
  it('advertises the four tools, only quorum_commit spending', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(annotations).toEqual({
      quorum_pools: { readOnlyHint: true },
      quorum_offer: { readOnlyHint: true },
      quorum_commit: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      quorum_status: { readOnlyHint: true },
    });
  });

  it('takes a pool id, and seats from 1 to 1000', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const inputs = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
    expect(inputs.quorum_pools?.required).toBeUndefined();
    expect(inputs.quorum_status?.required).toEqual(['pool']);
    for (const name of ['quorum_offer', 'quorum_commit']) {
      expect(inputs[name]?.required).toEqual(['pool', 'seats']);
      expect(inputs[name]?.properties).toMatchObject({
        pool: { type: 'integer', minimum: 0 },
        seats: { type: 'integer', minimum: 1, maximum: 1000 },
      });
    }
  });

  it('tells the agent which account it acts for', async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toContain(BUYER);
  });

  it("tells the agent that quorum_pools gives the gateway's word, which quorum_offer checks on chain", async () => {
    const { client } = await connect();
    const check = 'check a pool with quorum_offer, which reads it from the chain, before quorum_commit';
    expect(client.getInstructions()).toContain(check);
    const { tools } = await client.listTools();
    const pools = tools.find((tool) => tool.name === 'quorum_pools');
    expect(pools?.description).toContain("the gateway's listing, not checked");
    const listing = pools?.outputSchema?.properties?.pools as { items: { properties: Record<string, { description?: string }> } };
    const fields = listing.items.properties;
    for (const name of ['terms', 'seatPrice', 'taken', 'seatsLeft', 'deadlineMs', 'bonus', 'minBonusPerSeat']) {
      expect(fields[name]?.description).toContain("As the gateway lists it, not checked: quorum_offer checks a pool on chain");
    }
    const offer = tools.find((tool) => tool.name === 'quorum_offer');
    expect(offer?.description).toContain('read from the pools contract');
  });

  it('tells the agent when a refunded status has no transaction yet, and when a no_seats is final', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const status = tools.find((tool) => tool.name === 'quorum_status');
    expect(status?.description).toContain(
      '`refunded` (the contract has marked the seats refunded; `txHash` is the refund transaction once the gateway ' +
        'has recorded it, else null: the transfer may still be running, or the refund was claimed directly; a ' +
        'refund whose transfer fails turns `claimable`)',
    );
    expect(status?.description).toContain('final only once the wait that quorum_commit gave has passed');
    const txHash = (status?.outputSchema?.properties?.txHash as { description?: string } | undefined)?.description;
    expect(txHash).toBe(
      'A refund: its NEAR transaction hash, as the gateway recorded it; null while it has not, or for a refund claimed directly',
    );
    const commit = tools.find((tool) => tool.name === 'quorum_commit');
    expect(commit?.description).toContain('`payment_unsettled`');
  });

  const refunded = { kind: 'refund', status: 'refund_pending', amount: 438n, bonusShare: 78n, txHash: null } as const;
  it.each<[string, string, Record<string, unknown> | undefined, Answers]>([
    ['the open pools', 'quorum_pools', undefined, {}],
    [
      'more open pools than it lists',
      'quorum_pools',
      undefined,
      { pools: { kind: 'pools', pools: Array.from({ length: 51 }, (_, id) => ({ ...LISTING, id })) } },
    ],
    [
      'a pool whose deadline is past the last date a Date holds',
      'quorum_pools',
      undefined,
      { pools: { kind: 'pools', pools: [{ ...LISTING, deadline_ms: 9_000_000_000_000_000 }] } },
    ],
    ['a payable offer', 'quorum_offer', { pool: 7, seats: 2 }, {}],
    ['an offer over the spend cap', 'quorum_offer', { pool: 7, seats: 24 }, {}],
    ['a payment that took seats', 'quorum_commit', { pool: 7, seats: 2 }, {}],
    ['a payment that filled the pool', 'quorum_commit', { pool: 7, seats: 2 }, { pay: filled(2) }],
    [
      'seats in a pool still filling',
      'quorum_status',
      { pool: 7 },
      { redeem: { kind: 'pending', seats: 2, taken: 150, target: 192, deadlineMs: POOL.deadline_ms } },
    ],
    [
      'seats in a filled pool',
      'quorum_status',
      { pool: 7 },
      { redeem: { kind: 'filled', credential: CREDENTIAL, poolId: 7, seats: 2, terms: TERMS } },
    ],
    ['a refund not sent yet', 'quorum_status', { pool: 7 }, { redeem: refunded }],
    ['no seats', 'quorum_status', { pool: 7 }, { redeem: { kind: 'no_seats' } }],
  ])('answers %s with output that fits its schema, as structured content and as JSON text', async (_, name, args, answers) => {
    await writeSpendFile(join(dir, 'mcp-spend.json'), BUYER, 6_000n);
    const { client } = await connect(answers);
    const result = await call(client, name, args);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeDefined();
    expect(JSON.parse(text(result))).toEqual(result.structuredContent);
  });

  it('tells the agent, in its instructions and in quorum_commit, that a call ending without an answer may have paid', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const advice = 'a call that ends without an answer may have paid: call quorum_status before committing again';
    expect(client.getInstructions()).toContain(advice);
    expect(tools.find((tool) => tool.name === 'quorum_commit')?.description).toContain(`A${advice.slice(1)}.`);
  });

  it("passes the client's cancellation to quorum_commit: a payment cancelled once handed over holds the pool", async () => {
    const controller = new AbortController();
    const { client, calls, logs } = await connect({
      duringPay: async () => {
        controller.abort();
        // The cancellation reaches the server while the payment is in flight.
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    const cancelled = client.callTool({ name: 'quorum_commit', arguments: { pool: 7, seats: 2 } }, undefined, { signal: controller.signal });
    await expect(cancelled).rejects.toThrow();
    await vi.waitFor(() => expect(logs.some((line) => line.includes('was cancelled'))).toBe(true));

    const next = await call(client, 'quorum_commit', { pool: 7, seats: 2 });

    expect(next.isError).toBe(true);
    expect(JSON.parse(text(next))).toMatchObject({ error: 'payment_unsettled' });
    expect(calls.pay).toHaveLength(1);
  });

  it('answers a failure with isError, and its code and message as JSON text', async () => {
    const { client, calls } = await connect({ pay: signed({ kind: 'result_unknown', txHash: TX_HASH }) });
    const result = await call(client, 'quorum_commit', { pool: 7, seats: 2 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(text(result))).toEqual({ error: 'result_unknown', message: expect.stringContaining(TX_HASH) });
    expect(calls.pay).toHaveLength(1);
  });

  /** What near-api-js throws for an RPC's 502: its message quotes the RPC URL, its cause is the status. */
  const badGateway = (): Error => new Error(`${RPC_URL} Bad Gateway`, { cause: 502 });
  it.each<[string, Record<string, unknown> | undefined, Answers, RegExp]>([
    ['quorum_pools', undefined, { pools: badGateway() }, /could not list the pools \(HTTP 502\)/],
    ['quorum_offer', { pool: 7, seats: 2 }, { offer: badGateway() }, /could not make the offer for pool 7 \(HTTP 502\)/],
    [
      'quorum_commit',
      { pool: 7, seats: 2 },
      { offer: badGateway() },
      /pool 7 failed \(HTTP 502\).*call quorum_status for pool 7/,
    ],
    ['quorum_status', { pool: 7 }, { redeem: badGateway() }, /could not learn this account's seats in pool 7 \(HTTP 502\)/],
  ])(
    'answers an error that %s throws as a request_failed failure in its own words, the detail redacted on the log',
    async (name, args, answers, message) => {
      const { client, logs } = await connect(answers);
      const result = await call(client, name, args);
      expect(result.isError).toBe(true);
      const failure = JSON.parse(text(result)) as { error: string; message: string };
      expect(failure).toEqual({ error: 'request_failed', message: expect.stringMatching(message) });
      expect(failure.message).not.toContain('rpc.example.org');
      expect(failure.message).not.toContain('Bad Gateway');
      expect(logs).toEqual([`${name}: QUORUM_RPC_URL Bad Gateway`]);
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['quorum_offer', { pool: -1, seats: 1 }],
    ['quorum_offer', { pool: 1.5, seats: 1 }],
    ['quorum_offer', { pool: '7', seats: 1 }],
    ['quorum_commit', { pool: 7, seats: 0 }],
    ['quorum_commit', { pool: 7, seats: 1001 }],
    ['quorum_commit', { pool: 7, seats: 2.5 }],
    ['quorum_commit', { pool: 7 }],
    ['quorum_status', {}],
  ])('refuses the input of %s %j with isError, asking the gateway nothing', async (name, args) => {
    const { client, calls } = await connect();
    const result = await call(client, name, args);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Input validation error/);
    expect(calls).toEqual({ pools: 0, offer: [], pay: [], redeem: [], finalHeight: 0, getPool: [] });
  });
});
