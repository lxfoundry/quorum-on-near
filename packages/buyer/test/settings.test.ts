import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSpendFile } from '../src/spend-file.ts';
import {
  asAbsolutePath,
  asAmount,
  asInteger,
  asNear,
  asPositiveInteger,
  completeConfig,
  ConfigError,
  EnvReader,
  readBuyerSettings,
  readMcpBuyerSettings,
  type BuyerSettings,
  type Env,
  type McpBuyerSettings,
} from '../src/settings.ts';

const PARENT = 'parent.testnet';

/** The buyer settings read from `env`, with the problems found. */
function read(env: Env): { settings: Partial<BuyerSettings>; problems: string[] } {
  const problems: string[] = [];
  const settings = readBuyerSettings(env, problems);
  return { settings, problems };
}

describe('readBuyerSettings', () => {
  it("applies the gateway's defaults when only the parent account is set", () => {
    const { settings, problems } = read({ QUORUM_PARENT_ACCOUNT: PARENT });
    expect(problems).toEqual([]);
    expect(settings).toEqual<BuyerSettings>({
      network: 'near:testnet',
      rpcUrl: 'https://test.rpc.fastnear.com',
      gatewayUrl: 'http://localhost:8402',
      parent: PARENT,
      token: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
      poolsContract: 'pools.parent.testnet',
      blockTimeMs: 1000,
      maxTimeoutSeconds: 120,
    });
  });

  it('reads every variable that is set', () => {
    const { settings, problems } = read({
      QUORUM_NETWORK: 'near:sandbox',
      QUORUM_RPC_URL: 'http://127.0.0.1:3030',
      QUORUM_GATEWAY_URL: 'https://gateway.example.com:8443',
      QUORUM_PARENT_ACCOUNT: 'test.near',
      QUORUM_TOKEN_ACCOUNT: 'musd.test.near',
      QUORUM_POOLS_ACCOUNT: 'escrow.test.near',
      QUORUM_BLOCK_TIME_MS: '600',
      QUORUM_BUYER_MAX_TIMEOUT_SECONDS: '300',
    });
    expect(problems).toEqual([]);
    expect(settings).toEqual<BuyerSettings>({
      network: 'near:sandbox',
      rpcUrl: 'http://127.0.0.1:3030',
      gatewayUrl: 'https://gateway.example.com:8443',
      parent: 'test.near',
      token: 'musd.test.near',
      poolsContract: 'escrow.test.near',
      blockTimeMs: 600,
      maxTimeoutSeconds: 300,
    });
  });

  it('strips trailing slashes from the gateway URL, as the gateway does', () => {
    const { settings } = read({ QUORUM_PARENT_ACCOUNT: PARENT, QUORUM_GATEWAY_URL: 'http://localhost:8402//' });
    expect(settings.gatewayUrl).toBe('http://localhost:8402');
  });

  it('keeps the RPC URL as written', () => {
    const { settings } = read({ QUORUM_PARENT_ACCOUNT: PARENT, QUORUM_RPC_URL: 'http://127.0.0.1:3030/' });
    expect(settings.rpcUrl).toBe('http://127.0.0.1:3030/');
  });

  it('reads the longest expiry the buyer signs, from 30 to 3600 seconds', () => {
    const at = (raw: string) => read({ QUORUM_PARENT_ACCOUNT: PARENT, QUORUM_BUYER_MAX_TIMEOUT_SECONDS: raw });
    expect(at('30').settings.maxTimeoutSeconds).toBe(30);
    expect(at('3600').settings.maxTimeoutSeconds).toBe(3600);
    expect(at('29').problems).toEqual(['QUORUM_BUYER_MAX_TIMEOUT_SECONDS must be an integer from 30 to 3600, got "29"']);
    expect(at('3601').problems).toEqual(['QUORUM_BUYER_MAX_TIMEOUT_SECONDS must be an integer from 30 to 3600, got "3601"']);
  });

  it('requires the parent account, and gives the pools account no default without it', () => {
    const { settings, problems } = read({});
    expect(problems).toEqual(['QUORUM_PARENT_ACCOUNT is required']);
    expect(settings.parent).toBeUndefined();
    expect(settings.poolsContract).toBeUndefined();
  });

  it('treats an empty parent account as missing', () => {
    expect(read({ QUORUM_PARENT_ACCOUNT: '' }).problems).toEqual(['QUORUM_PARENT_ACCOUNT is required']);
  });

  it('collects one problem per invalid variable, naming each value but a URL', () => {
    const { settings, problems } = read({
      QUORUM_NETWORK: 'near:mainnet',
      QUORUM_RPC_URL: 'ftp://rpc.example.com',
      QUORUM_GATEWAY_URL: 'localhost:8402',
      QUORUM_PARENT_ACCOUNT: 'Parent.testnet',
      QUORUM_TOKEN_ACCOUNT: 'usdc..testnet',
      QUORUM_POOLS_ACCOUNT: 'pools/x',
      QUORUM_BLOCK_TIME_MS: '0',
      QUORUM_BUYER_MAX_TIMEOUT_SECONDS: '120.5',
    });
    expect(problems).toEqual([
      'QUORUM_NETWORK must be near:testnet or near:sandbox, got "near:mainnet"',
      'QUORUM_RPC_URL must be an http or https URL',
      'QUORUM_GATEWAY_URL must be an http or https URL',
      'QUORUM_PARENT_ACCOUNT must be a NEAR account id, got "Parent.testnet"',
      'QUORUM_TOKEN_ACCOUNT must be a NEAR account id, got "usdc..testnet"',
      'QUORUM_POOLS_ACCOUNT must be a NEAR account id, got "pools/x"',
      'QUORUM_BLOCK_TIME_MS must be a positive integer, got "0"',
      'QUORUM_BUYER_MAX_TIMEOUT_SECONDS must be an integer from 30 to 3600, got "120.5"',
    ]);
    expect(Object.values(settings).every((value) => value === undefined)).toBe(true);
  });

  it('never quotes the value of a URL variable, which may carry an API key', () => {
    const { problems } = read({
      QUORUM_PARENT_ACCOUNT: PARENT,
      QUORUM_RPC_URL: 'htps://rpc.example.org/?apiKey=SECRET-KEY',
      QUORUM_GATEWAY_URL: 'gateway.example.org/?token=SECRET-TOKEN',
    });
    expect(problems).toEqual(['QUORUM_RPC_URL must be an http or https URL', 'QUORUM_GATEWAY_URL must be an http or https URL']);
  });

  it('appends to the problems already collected', () => {
    const problems = ['QUORUM_OTHER must be set'];
    readBuyerSettings({}, problems);
    expect(problems).toEqual(['QUORUM_OTHER must be set', 'QUORUM_PARENT_ACCOUNT is required']);
  });
});

describe('readMcpBuyerSettings', () => {
  /** The MCP server's buyer read from `env` for the parent PARENT, with the problems found. */
  function readMcp(env: Env) {
    const problems: string[] = [];
    const settings = readMcpBuyerSettings(env, problems, PARENT);
    return { settings, problems };
  }

  it('names the buyer after the parent, and keeps its key and its spend total where the server looks by default', () => {
    const { settings, problems } = readMcp({});
    expect(settings).toEqual<McpBuyerSettings>({
      mcpAccount: 'buyer-llm.parent.testnet',
      credentialsDir: join(homedir(), '.near-credentials'),
      spendFile: defaultSpendFile(),
    });
    expect(problems).toEqual([]);
  });

  it('reads every variable that is set', () => {
    const credentialsDir = join(tmpdir(), 'near-keys');
    const spendFile = join(tmpdir(), 'spend.json');
    const { settings } = readMcp({
      QUORUM_MCP_ACCOUNT: 'agent.test.near',
      QUORUM_CREDENTIALS_DIR: credentialsDir,
      QUORUM_MCP_SPEND_FILE: spendFile,
    });
    expect(settings).toEqual<McpBuyerSettings>({ mcpAccount: 'agent.test.near', credentialsDir, spendFile });
  });

  it('appends one problem per invalid variable, in the order of the fields', () => {
    const problems = ['QUORUM_OTHER must be set'];
    const settings = readMcpBuyerSettings(
      { QUORUM_MCP_ACCOUNT: 'llm buyer', QUORUM_CREDENTIALS_DIR: 'keys', QUORUM_MCP_SPEND_FILE: 'data/mcp-spend.json' },
      problems,
      PARENT,
    );
    expect(problems).toEqual([
      'QUORUM_OTHER must be set',
      'QUORUM_MCP_ACCOUNT must be a NEAR account id, got "llm buyer"',
      'QUORUM_CREDENTIALS_DIR must be an absolute path, got "keys"',
      'QUORUM_MCP_SPEND_FILE must be an absolute path, got "data/mcp-spend.json"',
    ]);
    expect(Object.values(settings).every((value) => value === undefined)).toBe(true);
  });

  it('gives the buyer no default without a parent, adding no problem of its own', () => {
    const problems: string[] = [];
    const settings = readMcpBuyerSettings({}, problems, undefined);
    expect(settings.mcpAccount).toBeUndefined();
    expect(problems).toEqual([]);
  });
});

describe('completeConfig', () => {
  it('returns the draft when no problem was found', () => {
    const problems: string[] = [];
    const draft = readBuyerSettings({ QUORUM_PARENT_ACCOUNT: PARENT }, problems);
    expect(completeConfig<BuyerSettings>(draft, problems).poolsContract).toBe('pools.parent.testnet');
  });

  it('throws one ConfigError listing every problem, one per line', () => {
    const problems = ['QUORUM_A is required', 'QUORUM_B must be a positive integer, got "x"'];
    let thrown: unknown;
    try {
      completeConfig<{ a: string }>({ a: undefined }, problems);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const error = thrown as ConfigError;
    expect(error.problems).toEqual(problems);
    expect(error.message).toBe('QUORUM_A is required\nQUORUM_B must be a positive integer, got "x"');
  });
});

describe('EnvReader', () => {
  /** A reader of `env`, and the problems it collects. */
  function reader(env: Env): { read: EnvReader; problems: string[] } {
    const problems: string[] = [];
    return { read: new EnvReader(env, problems), problems };
  }

  it('optional reads the fallback when the variable is unset', () => {
    const { read, problems } = reader({});
    expect(read.optional('QUORUM_X', '5', asPositiveInteger)).toBe(5);
    expect(problems).toEqual([]);
  });

  it('optional checks an empty value with the rule rather than using the fallback', () => {
    const { read, problems } = reader({ QUORUM_X: '' });
    expect(read.optional('QUORUM_X', '5', asPositiveInteger)).toBeUndefined();
    expect(problems).toEqual(['QUORUM_X must be a positive integer, got ""']);
  });

  it('required reports an unset variable', () => {
    const { read, problems } = reader({});
    expect(read.required('QUORUM_X', asPositiveInteger)).toBeUndefined();
    expect(problems).toEqual(['QUORUM_X is required']);
  });

  it('nullable gives null for an unset or empty variable, and checks any other value', () => {
    const { read, problems } = reader({ QUORUM_EMPTY: '', QUORUM_SET: '7', QUORUM_BAD: 'seven' });
    expect(read.nullable('QUORUM_UNSET', asPositiveInteger)).toBeNull();
    expect(read.nullable('QUORUM_EMPTY', asPositiveInteger)).toBeNull();
    expect(read.nullable('QUORUM_SET', asPositiveInteger)).toBe(7);
    expect(read.nullable('QUORUM_BAD', asPositiveInteger)).toBeUndefined();
    expect(problems).toEqual(['QUORUM_BAD must be a positive integer, got "seven"']);
  });

  it('child defaults to <prefix>.<parent>', () => {
    const { read } = reader({});
    expect(read.child('QUORUM_RELAYER_ACCOUNT', 'relay', PARENT)).toBe('relay.parent.testnet');
  });

  it('child reads the variable when it is set, checking it is an account id', () => {
    const { read, problems } = reader({ QUORUM_A: 'me.testnet', QUORUM_B: 'not an account' });
    expect(read.child('QUORUM_A', 'a', PARENT)).toBe('me.testnet');
    expect(read.child('QUORUM_B', 'b', PARENT)).toBeUndefined();
    expect(problems).toEqual(['QUORUM_B must be a NEAR account id, got "not an account"']);
  });

  it('child reports nothing without a parent, whose problem is listed already', () => {
    const { read, problems } = reader({});
    expect(read.child('QUORUM_RELAYER_ACCOUNT', 'relay', undefined)).toBeUndefined();
    expect(problems).toEqual([]);
  });
});

describe('rules', () => {
  it('asNear reads a decimal amount of NEAR into yoctoNEAR', () => {
    expect(asNear.parse('0.05')).toBe(50_000_000_000_000_000_000_000n);
    expect(asNear.parse('3')).toBe(3_000_000_000_000_000_000_000_000n);
    expect(asNear.parse('3.5')).toBe(3_500_000_000_000_000_000_000_000n);
    // A JS number this small is written 1e-7, which a NEAR amount parser refuses.
    expect(asNear.parse('0.0000001')).toBe(100_000_000_000_000_000n);
    expect(asNear.parse('0.000000000000000000000001')).toBe(1n);
    expect(asNear.parse('0')).toBe(0n);
  });

  it.each(['', '1e-7', '-1', '1,000', '.5', '5.', '01', '0.0000000000000000000000001', ' 1', 'one'])(
    'asNear refuses %j',
    (raw) => {
      expect(asNear.parse(raw)).toBeUndefined();
    },
  );

  it('asAmount reads a decimal amount of base units', () => {
    expect(asAmount.parse('0')).toBe(0n);
    expect(asAmount.parse('10000')).toBe(10_000n);
    expect(asAmount.parse('340282366920938463463374607431768211455')).toBe(2n ** 128n - 1n);
  });

  it.each(['', '01', '-1', '1.5', '1e3', ' 1'])('asAmount refuses %j', (raw) => {
    expect(asAmount.parse(raw)).toBeUndefined();
  });

  it('asInteger accepts its bounds and refuses values outside them', () => {
    const rule = asInteger(1, 10);
    expect(rule.parse('1')).toBe(1);
    expect(rule.parse('10')).toBe(10);
    expect(rule.parse('0')).toBeUndefined();
    expect(rule.parse('11')).toBeUndefined();
    expect(rule.expected).toBe('an integer from 1 to 10');
  });

  it.each(['0', '-1', '1.5', '01', '', '9007199254740992'])('asPositiveInteger refuses %j', (raw) => {
    expect(asPositiveInteger.parse(raw)).toBeUndefined();
  });

  it('asAbsolutePath accepts an absolute path and refuses a relative one', () => {
    const absolute = join(tmpdir(), 'near-keys');
    expect(asAbsolutePath.parse(absolute)).toBe(absolute);
    expect(asAbsolutePath.parse('keys')).toBeUndefined();
    expect(asAbsolutePath.parse('~/.near-credentials')).toBeUndefined();
    expect(asAbsolutePath.parse('')).toBeUndefined();
  });
});
