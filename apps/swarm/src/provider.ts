import { keyFilePath, readKeyFile } from '@quorum-on-near/buyer';
import { poolsEvents } from '@quorum-on-near/protocol';
import { allPools, NonceTakenError, OutcomeUnknownError, type SwarmChain, type TransferCallResult } from './chain.ts';
import type { SwarmConfig } from './config.ts';
import type { Scenario } from './scenarios.ts';

/** A pool the provider opened. `deadlineMs` is in block time, milliseconds since the epoch. */
export interface OpenedPool {
  poolId: number;
  txHash: string;
  deadlineMs: number;
}

/** What openPool uses: the chain, and a logger for the line it writes once the pool is open. */
export interface OpenPoolDeps {
  chain: Pick<SwarmChain, 'finalBlock' | 'ftTransferCall' | 'listPools'>;
  log: (line: string) => void;
}

/**
 * The provider has a pool that is still Open, so openPool sent nothing: each scripted buyer's budget
 * covers one pool, so a second open pool would leave buyers unable to pay for their seats. A send
 * that timed out before its result was known may have opened that pool. `poolIds` lists the open
 * pools, in id order. The pools are read at optimistic finality, so a pool counts as soon as the
 * pools contract's receipt that opened it has run; a bonus transfer already in a block whose receipt
 * at the pools contract has not run yet, a block or two later, is not seen. Hence openPool's advice,
 * after a transfer that got no result, to wait until it is final before trying again.
 */
export class PoolAlreadyOpenError extends Error {
  override name = 'PoolAlreadyOpenError';
  readonly poolIds: number[];

  constructor(provider: string, poolIds: number[]) {
    const one = poolIds.length === 1;
    const pools = one ? `pool ${poolIds[0]}` : `pools ${poolIds.join(', ')}`;
    const resume = one ? `\`swarm run ${poolIds[0]} <fills|fails>\` resumes its buyers` : "`swarm run <pool-id> <fills|fails>` resumes a pool's buyers";
    super(
      `the provider ${provider} has ${pools} open, and each buyer's budget covers one pool: ` +
        `no other pool is opened until ${one ? 'it has' : 'they have'} ended, and nothing was sent; ${resume}`,
    );
    this.poolIds = poolIds;
  }
}

/**
 * The bonus transfer ran, but did not open the pool it was sent for. The token returns to the
 * provider whatever the pools contract did not keep. The message names the transaction.
 */
export class OpenPoolError extends Error {
  override name = 'OpenPoolError';
  readonly txHash: string;

  constructor(message: string, txHash: string) {
    super(message);
    this.txHash = txHash;
  }
}

/**
 * Throws PoolAlreadyOpenError, sending nothing, when one of the provider's pools is Open. A pools
 * account that does not exist or holds no contract yet has no pool, so nothing more is read; otherwise
 * every pool is read (the contract's views derive the status from block time, so a pool past its
 * deadline is not Open). `swarm demo` calls it before setup, so that it refuses before anything is
 * sent; openPool makes the same check just before its own send.
 */
export async function assertNoPoolOpen(
  config: Pick<SwarmConfig, 'provider' | 'poolsContract'>,
  chain: Pick<SwarmChain, 'account' | 'listPools'>,
): Promise<void> {
  const pools = await chain.account(config.poolsContract);
  if (pools === null || !pools.hasCode) return;
  await refuseWhileOpen(config, chain);
}

/**
 * Throws PoolAlreadyOpenError when one of the provider's pools, read with list_pools at optimistic
 * finality, is Open.
 */
async function refuseWhileOpen(config: Pick<SwarmConfig, 'provider'>, chain: Pick<SwarmChain, 'listPools'>): Promise<void> {
  const open = (await allPools(chain, 'optimistic')).filter((pool) => pool.seller === config.provider && pool.status === 'open');
  if (open.length > 0) throw new PoolAlreadyOpenError(config.provider, open.map((pool) => pool.id));
}

/** What `swarm open` advises once its bonus transfer may have opened a pool it could not learn of. */
const OPEN_AGAIN = "Wait until it is final, then run `swarm open` again; it lists the provider's open pools.";

/** The bonus transfer's error, reworded as `swarm open` says it when the transfer may have opened a pool. */
function mayHaveOpened(error: unknown): unknown {
  if (error instanceof NonceTakenError) {
    return new NonceTakenError(
      `the provider's key signed another transaction after its nonce was read (transaction ${error.txHash} was refused): ` +
        `an earlier \`swarm open\` may have opened a pool. ${OPEN_AGAIN}`,
      error.txHash,
      { cause: error },
    );
  }
  if (error instanceof OutcomeUnknownError) {
    const transfer = error.txHash === null ? 'the bonus transfer may have been sent' : `the bonus transfer ${error.txHash} was sent`;
    return new OutcomeUnknownError(
      `${transfer}, but the RPC gave no result (${error.reason}): a pool may have opened. ${OPEN_AGAIN}`,
      error.txHash,
      error.reason,
      { cause: error },
    );
  }
  return error;
}

/**
 * Opens the scenario's pool as the provider, signing with the key in its key file: sends the bonus to
 * the pools contract with `ft_transfer_call` and an `open` message. The deadline is the final block's
 * time plus the scenario's deadline, since the contract checks deadlines against block time, never
 * the local clock. Returns the id the contract gave the pool, read from its `pool_opened` event.
 * Before anything else, reads every pool and throws PoolAlreadyOpenError, sending nothing, when one
 * of the provider's is Open (the contract's views derive the status from block time, so a pool past
 * its deadline is not). Throws OpenPoolError when the pools contract logged no such event or the
 * token did not keep the whole bonus, KeyFileError (before sending anything) when the key file is
 * missing or unreadable, and passes on the chain's error when the transfer itself failed. The bonus
 * transfer is sent once: when another transaction of the provider's key took its nonce
 * (NonceTakenError), or it got no result (OutcomeUnknownError), the error names the transaction and
 * says that a pool may have opened, and to run `swarm open` again once that is final.
 */
export async function openPool(
  config: Pick<SwarmConfig, 'credentialsDir' | 'network' | 'provider' | 'poolsContract'>,
  deps: OpenPoolDeps,
  scenario: Scenario,
): Promise<OpenedPool> {
  await refuseWhileOpen(config, deps.chain);
  const keyPair = await readKeyFile(keyFilePath(config.credentialsDir, config.network, config.provider));
  const block = await deps.chain.finalBlock();
  const deadlineMs = block.timestampMs + scenario.deadlineSeconds * 1000;
  const msg = JSON.stringify({
    open: {
      seat_price: scenario.seatPrice.toString(),
      target: scenario.target,
      deadline_ms: deadlineMs,
      max_seats_per_buyer: scenario.maxSeatsPerBuyer,
      terms: scenario.terms,
    },
  });
  let sent: TransferCallResult;
  try {
    sent = await deps.chain.ftTransferCall({ accountId: config.provider, keyPair }, { receiverId: config.poolsContract, amount: scenario.bonus, msg });
  } catch (error) {
    throw mayHaveOpened(error);
  }
  const { outcome, used } = sent;
  const { txHash } = outcome;
  const kept = `the token kept ${used} of the ${scenario.bonus} bonus`;
  const event = poolsEvents(outcome, config.poolsContract).find((e) => e.event === 'pool_opened');
  if (event === undefined) {
    throw new OpenPoolError(`transaction ${txHash} opened no pool: the pools contract logged no pool_opened event, and ${kept}`, txHash);
  }
  const poolId: unknown = event.data.pool_id;
  if (typeof poolId !== 'number' || !Number.isSafeInteger(poolId) || poolId < 0) {
    throw new OpenPoolError(`transaction ${txHash} logged a pool_opened event without a valid pool id`, txHash);
  }
  if (used !== scenario.bonus) {
    throw new OpenPoolError(`transaction ${txHash} opened pool ${poolId}, but ${kept}`, txHash);
  }
  deps.log(
    `opened pool ${poolId} (${scenario.name}): ${scenario.target} seats at ${scenario.seatPrice}, bonus ${scenario.bonus}, ` +
      `deadline ${new Date(deadlineMs).toISOString()}  tx ${txHash}`,
  );
  return { poolId, txHash, deadlineMs };
}
