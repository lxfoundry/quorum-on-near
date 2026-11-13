import type { SwarmConfig } from './config.ts';
import { PROFILES, profileAccount } from './profiles.ts';

/** What an account is for. */
export type AccountRole = 'funding' | 'pools' | 'relayer' | 'provider' | 'buyer';

/** One of the system's accounts, with what setup gives it. */
export interface SwarmAccount {
  id: string;
  role: AccountRole;
  /** Setup creates it when it is missing: it is a direct sub-account of the parent. */
  create: boolean;
  /** The full-access keys setup gives it when it creates it: QUORUM_RELAYER_KEY_COUNT for the relayer, else 1. */
  keyCount: number;
  /** The NEAR balance setup tops it up to, in yoctoNEAR; null for a funding account that is the parent. */
  near: bigint | null;
  /** Setup registers it on the token. */
  onToken: boolean;
  /** The token balance setup tops it up to and reset brings it back to, in base units; null when none. */
  tokens: bigint | null;
}

/** The scripted buyers' accounts, `buyer-01.<parent>` to `buyer-20.<parent>`: one per profile, in the order of PROFILES. */
export function scriptedBuyerIds(parent: string): string[] {
  return PROFILES.map((profile) => profileAccount(profile, parent));
}

/** Every buyer: the scripted ones, then the MCP server's. */
export function buyerIds(config: Pick<SwarmConfig, 'parent' | 'mcpAccount'>): string[] {
  return [...scriptedBuyerIds(config.parent), config.mcpAccount];
}

/**
 * Whether `id` is a direct sub-account of `parent`, such as `buyer-01.<parent>`: the only kind of
 * account `parent` can create. `a.buyer-01.<parent>` can be created only by `buyer-01.<parent>`.
 */
export function isSubAccount(id: string, parent: string): boolean {
  const suffix = `.${parent}`;
  return id.endsWith(suffix) && !id.slice(0, -suffix.length).includes('.');
}

/**
 * The system's accounts in the order setup handles them: the funding account, the pools contract,
 * the relayer, the provider, then every buyer (buyerIds). The parent is listed only when it is also
 * the funding account: it pays for the others.
 */
export function swarmAccounts(config: SwarmConfig): SwarmAccount[] {
  type Targets = Pick<SwarmAccount, 'near' | 'onToken' | 'tokens'>;
  const account = (id: string, role: AccountRole, targets: Targets): SwarmAccount => ({
    id,
    role,
    create: isSubAccount(id, config.parent),
    keyCount: role === 'relayer' ? config.relayerKeyCount : 1,
    ...targets,
  });
  const fundingNear = config.funding === config.parent ? null : config.fundingNear;
  return [
    account(config.funding, 'funding', { near: fundingNear, onToken: true, tokens: null }),
    account(config.poolsContract, 'pools', { near: config.poolsNear, onToken: true, tokens: null }),
    account(config.relayer, 'relayer', { near: config.relayerNear, onToken: false, tokens: null }),
    account(config.provider, 'provider', { near: config.providerNear, onToken: true, tokens: config.providerBonusFunds }),
    ...buyerIds(config).map((id) => account(id, 'buyer', { near: config.buyerNear, onToken: true, tokens: config.buyerBudget })),
  ];
}
