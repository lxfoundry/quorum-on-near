import { keyFilePath, readKeyFile } from '@quorum-on-near/buyer';
import { swarmAccounts } from './accounts.ts';
import { checkChain, rerunAdvice, type SwarmChain } from './chain.ts';
import type { SwarmConfig } from './config.ts';

/** What runReset uses: the chain, and a logger for the line it writes for each transfer. */
export interface ResetDeps {
  chain: Pick<SwarmChain, 'chainId' | 'ftBalanceOf' | 'ftTransfers'>;
  log: (line: string) => void;
}

/** One surplus reset sent back: from `accountId` to the funding account, in base units. */
export interface ReturnedSurplus {
  accountId: string;
  amount: bigint;
  txHash: string;
}

/**
 * `swarm reset` (spec section 7.2): each buyer and the provider sends the funding account whatever
 * it holds on the token above its configured amount (QUORUM_BUYER_BUDGET, QUORUM_PROVIDER_BONUS_FUNDS),
 * one `ft_transfer` each, signed with its own key file's key. It moves balances only: money a pool
 * still holds is not counted, and no refund is claimed. An account at or below its amount sends
 * nothing and needs no key file, so a second reset in a row transfers nothing.
 *
 * Before sending, it checks the RPC's chain against QUORUM_NETWORK (ConfigError). It stops at the
 * first error (KeyFileError for a missing key file, or the chain's): the transfers made before it
 * stand, and running it again sends only what is still above the amounts, as a transfer that got no
 * result (OutcomeUnknownError) says.
 */
export async function runReset(config: SwarmConfig, deps: ResetDeps): Promise<ReturnedSurplus[]> {
  try {
    return await returnSurpluses(config, deps);
  } catch (error) {
    throw rerunAdvice(error, 'Reset', 'it sends only what is still above the amounts');
  }
}

async function returnSurpluses(config: SwarmConfig, deps: ResetDeps): Promise<ReturnedSurplus[]> {
  const { chain } = deps;
  await checkChain(config.network, chain);
  const returned: ReturnedSurplus[] = [];
  for (const { id, tokens } of swarmAccounts(config)) {
    if (tokens === null) continue;
    const amount = (await chain.ftBalanceOf(id)) - tokens;
    if (amount <= 0n) continue;
    const keyPair = await readKeyFile(keyFilePath(config.credentialsDir, config.network, id));
    const { txHash } = await chain.ftTransfers({ accountId: id, keyPair }, [{ receiverId: config.funding, amount }]);
    deps.log(`${id}  returned ${amount} to ${config.funding}  tx ${txHash}`);
    returned.push({ accountId: id, amount, txHash });
  }
  if (returned.length === 0) deps.log('nothing to do');
  return returned;
}
