import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAmount } from '@quorum-on-near/protocol';

/**
 * The MCP server's running total of what its buyer has spent, in the token's base units, kept on
 * disk so that a restart does not reset it: `{"account": "<buyer>", "spent": "<base units>"}`. The
 * MCP server keeps it. `swarm setup` clears it on every run whose token top-ups go through, also when
 * none was needed, so that the cap bounds what the buyer spends between two such runs; a run stopped
 * before then, by a token shortfall for one, leaves it.
 */

/** What is wrong with a spend file: it holds another account's total, or no total at all. */
export type SpendFileProblem = 'other_account' | 'malformed';

/** A spend file that holds another account's total or cannot be read as one. */
export class SpendFileError extends Error {
  override name = 'SpendFileError';
  readonly path: string;
  readonly problem: SpendFileProblem;

  constructor(path: string, problem: SpendFileProblem, message: string) {
    super(message);
    this.path = path;
    this.problem = problem;
  }
}

/**
 * `data/mcp-spend.json` at the root of the repository, which is gitignored. Resolved from this
 * module's own location, so it does not depend on the folder the process was started from.
 */
export function defaultSpendFile(): string {
  return fileURLToPath(new URL('../../../data/mcp-spend.json', import.meta.url));
}

/**
 * The total `account` has spent: 0 when there is no file. Throws SpendFileError for a file that holds
 * another account's total (`other_account`) or is not a spend file (`malformed`).
 */
export async function readSpendFile(path: string, account: string): Promise<bigint> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0n;
    throw error;
  }
  const malformed = (): SpendFileError =>
    new SpendFileError(path, 'malformed', `the spend file ${path} does not hold an account and a decimal total`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed();
  const fields = value as Record<string, unknown>;
  const spent = parseAmount(fields.spent);
  if (typeof fields.account !== 'string' || spent === null) throw malformed();
  if (fields.account !== account) {
    throw new SpendFileError(path, 'other_account', `the spend file ${path} holds another account's total, not ${account}'s`);
  }
  return spent;
}

/**
 * Writes `account`'s total atomically: to a new temporary file in the same folder, then renamed over
 * `path`, so that a reader, or a process stopped mid-write, sees the old total or the new one, never
 * part of one. Creates the folder if needed. Writes to one file must not overlap: the caller
 * serialises them. Throws RangeError for a negative total.
 */
export async function writeSpendFile(path: string, account: string, spent: bigint): Promise<void> {
  if (spent < 0n) throw new RangeError(`a spent total cannot be negative: ${spent}`);
  const folder = dirname(path);
  await mkdir(folder, { recursive: true });
  const temporary = join(folder, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ account, spent: spent.toString() })}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
