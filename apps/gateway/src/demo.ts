import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/** The runs a visitor can start: a pool that fills, and one that fails. */
export type DemoScenario = 'fills' | 'fails';

export const DEMO_SCENARIOS: readonly DemoScenario[] = ['fills', 'fails'];

/**
 * The variables a run never gets: the relayer's keys and the credential key, which only the gateway
 * signs with, and the phrase every key is derived from. A run reads its own keys from their key files.
 */
export const WITHHELD_VARIABLES: readonly string[] = [
  'QUORUM_RELAYER_KEYS',
  'QUORUM_CREDENTIAL_JWK',
  'QUORUM_SEED_PHRASE',
  'QUORUM_SEED_PHRASE_FILE',
];

/** How long a run has to end after the SIGTERM of its maximum run time, before it gets SIGKILL. */
export const KILL_GRACE_MS = 10_000;

const DAY_MS = 86_400_000;
const PREFIX = '[demo] ';

/** The last run that ended. Times are milliseconds since the epoch. */
export interface DemoLast {
  scenario: DemoScenario;
  startedAt: number;
  endedAt: number;
  /** The exit code of a run that exited; null otherwise. */
  exitCode: number | null;
  /** The signal that ended a run that did not exit; null otherwise. Both are null for a program that could not be started. */
  signal: string | null;
}

/** `GET /demo`'s answer. `scenario` and `startedAt` are null when no run is in progress. */
export interface DemoStatus {
  running: boolean;
  scenario: DemoScenario | null;
  startedAt: number | null;
  last: DemoLast | null;
  runsToday: number;
  maxRunsPerDay: number;
}

/**
 * What `claim` answers: a run is in progress (its scenario and start), today's cap is reached, or the
 * slot is now the caller's, to `start` or `release` exactly once.
 */
export type DemoClaim =
  | { kind: 'running'; scenario: DemoScenario; startedAt: number }
  | { kind: 'limit' }
  | { kind: 'claimed'; startedAt: number; start(): Promise<DemoLast>; release(): void };

/** Where the runner writes its lines, each without its newline. */
export interface DemoOutput {
  stdout(line: string): void;
  stderr(line: string): void;
}

/** Starts a program without a shell, as node:child_process's spawn does. */
export type Spawn = (program: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Runs `run` once `ms` milliseconds have passed; the function it returns cancels that. */
export type Schedule = (run: () => void, ms: number) => () => void;

export interface DemoRunnerOptions {
  /** The program and its first arguments; the scenario is appended. Not empty. */
  command: readonly string[];
  maxRunsPerDay: number;
  /** A run still going after this long gets SIGTERM, then SIGKILL KILL_GRACE_MS later. */
  maxRunSeconds: number;
  /**
   * The gateway's environment, which a run gets without WITHHELD_VARIABLES and QUORUM_DEMO_RPC_URL.
   * Defaults to process.env.
   */
  env?: Record<string, string | undefined>;
  /** The run's QUORUM_RPC_URL, in place of the gateway's; unset or null: the run gets the gateway's. */
  rpcUrl?: string | null;
  /** The clock, in milliseconds since the epoch. Defaults to Date.now. */
  now?: () => number;
  /** Defaults to node:child_process's spawn. */
  spawn?: Spawn;
  /** Defaults to setTimeout. */
  schedule?: Schedule;
  /** Defaults to the gateway's standard output and error. */
  output?: DemoOutput;
}

const setTimer: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

const standardStreams: DemoOutput = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/** The UTC day `ms` falls in, as a count of days since the epoch. */
function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** Writes each line of `stream` with the prefix, and a last line without a newline once the stream ends. */
function forwardLines(stream: Readable | null, write: (line: string) => void): void {
  if (stream === null) return;
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => write(`${PREFIX}${line}`));
}

/** The run in progress, or a slot a request has claimed and not yet started or released. */
interface Slot {
  scenario: DemoScenario;
  startedAt: number;
  /** Null until the run's program is spawned. */
  child: ChildProcess | null;
}

/**
 * Starts the demo's runs, one at a time (hosted demo spec, section 4.3):
 * - `claim` checks the slot and takes it in one synchronous step, so two requests never both get it.
 *   The caller then starts the run or releases the slot.
 * - A run counts towards its UTC day's cap when it starts, even one whose program cannot be started.
 * - The program starts without a shell, with the command's arguments then the scenario, in the
 *   gateway's folder, with the gateway's environment minus WITHHELD_VARIABLES and QUORUM_DEMO_RPC_URL.
 *   Given an RPC URL of its own, the run gets it as its QUORUM_RPC_URL in place of the gateway's.
 * - Each line of its output goes to the gateway's standard output or error, prefixed `[demo] `.
 * - After its maximum run time it gets SIGTERM, then SIGKILL KILL_GRACE_MS later if it has not ended.
 * - `stop`, at the gateway's shutdown, sends SIGTERM to the run in progress.
 */
export class DemoRunner {
  readonly #command: readonly string[];
  readonly #maxRunsPerDay: number;
  readonly #maxRunSeconds: number;
  readonly #env: Record<string, string | undefined>;
  readonly #rpcUrl: string | null;
  readonly #now: () => number;
  readonly #spawn: Spawn;
  readonly #schedule: Schedule;
  readonly #output: DemoOutput;
  #slot: Slot | null = null;
  #last: DemoLast | null = null;
  /** The UTC day that #runs counts, or null before the first run. */
  #day: number | null = null;
  #runs = 0;
  #stopping = false;

  constructor(options: DemoRunnerOptions) {
    if (options.command.length === 0) throw new Error('the demo command needs a program');
    this.#command = options.command;
    this.#maxRunsPerDay = options.maxRunsPerDay;
    this.#maxRunSeconds = options.maxRunSeconds;
    this.#env = options.env ?? process.env;
    this.#rpcUrl = options.rpcUrl ?? null;
    this.#now = options.now ?? Date.now;
    this.#spawn = options.spawn ?? spawn;
    this.#schedule = options.schedule ?? setTimer;
    this.#output = options.output ?? standardStreams;
  }

  /**
   * Checks the slot and takes it in the same synchronous step. A run in progress comes first, then
   * today's cap.
   */
  claim(scenario: DemoScenario): DemoClaim {
    const busy = this.#slot;
    if (busy !== null) return { kind: 'running', scenario: busy.scenario, startedAt: busy.startedAt };
    const startedAt = this.#now();
    if (this.#runsOn(startedAt) >= this.#maxRunsPerDay) return { kind: 'limit' };
    const slot: Slot = { scenario, startedAt, child: null };
    this.#slot = slot;
    let used = false;
    const use = (): void => {
      if (used) throw new Error('this demo claim was already started or released');
      used = true;
    };
    return {
      kind: 'claimed',
      startedAt,
      start: () => {
        use();
        return this.#start(slot);
      },
      release: () => {
        use();
        this.#slot = null;
      },
    };
  }

  status(): DemoStatus {
    const slot = this.#slot;
    return {
      running: slot !== null,
      scenario: slot === null ? null : slot.scenario,
      startedAt: slot === null ? null : slot.startedAt,
      last: this.#last,
      runsToday: this.#runsOn(this.#now()),
      maxRunsPerDay: this.#maxRunsPerDay,
    };
  }

  /** At the gateway's shutdown: sends SIGTERM to the run in progress, and starts no run after it. */
  stop(): void {
    this.#stopping = true;
    const slot = this.#slot;
    if (slot === null || slot.child === null) return;
    this.#output.stderr(`${PREFIX}the gateway is stopping: sending SIGTERM to the ${slot.scenario} run`);
    slot.child.kill('SIGTERM');
  }

  /** The runs started on the UTC day `now` falls in. */
  #runsOn(now: number): number {
    return utcDay(now) === this.#day ? this.#runs : 0;
  }

  #count(startedAt: number): void {
    const day = utcDay(startedAt);
    if (day !== this.#day) {
      this.#day = day;
      this.#runs = 0;
    }
    this.#runs += 1;
  }

  /**
   * The gateway's environment without WITHHELD_VARIABLES and QUORUM_DEMO_RPC_URL, and with the run's own
   * RPC URL, if it has one, as its QUORUM_RPC_URL. Names are compared without case, as Windows does.
   */
  #childEnv(): Record<string, string | undefined> {
    const dropped = [...WITHHELD_VARIABLES, 'QUORUM_DEMO_RPC_URL', ...(this.#rpcUrl === null ? [] : ['QUORUM_RPC_URL'])];
    const env = Object.fromEntries(Object.entries(this.#env).filter(([name]) => !dropped.includes(name.toUpperCase())));
    return this.#rpcUrl === null ? env : { ...env, QUORUM_RPC_URL: this.#rpcUrl };
  }

  #trySpawn(program: string, args: string[]): ChildProcess | Error {
    try {
      return this.#spawn(program, args, { env: this.#childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Starts the claimed run. Resolves once it has ended and `last` records it; never rejects. */
  #start(slot: Slot): Promise<DemoLast> {
    this.#count(slot.startedAt);
    const { scenario, startedAt } = slot;
    const [program = '', ...rest] = this.#command;
    const args = [...rest, scenario];
    return new Promise((resolve) => {
      const cancels: Array<() => void> = [];
      let ended = false;
      const end = (exitCode: number | null, signal: string | null): void => {
        if (ended) return;
        ended = true;
        for (const cancel of cancels) cancel();
        const last: DemoLast = { scenario, startedAt, endedAt: this.#now(), exitCode, signal };
        this.#last = last;
        this.#slot = null;
        resolve(last);
      };
      const notStarted = (why: string): void => {
        this.#output.stderr(`${PREFIX}the ${scenario} run ${why}`);
        end(null, null);
      };

      if (this.#stopping) {
        notStarted('is not started: the gateway is stopping');
        return;
      }
      this.#output.stdout(`${PREFIX}starting the ${scenario} run: ${[program, ...args].join(' ')}`);
      const child = this.#trySpawn(program, args);
      if (child instanceof Error) {
        notStarted(`could not be started: ${child.message}`);
        return;
      }
      slot.child = child;
      let spawned = false;
      child.once('spawn', () => {
        spawned = true;
      });
      // Emitted instead of 'spawn' when the program cannot be started, and when a signal cannot be sent.
      child.on('error', (error) => {
        if (spawned) this.#output.stderr(`${PREFIX}the ${scenario} run: ${error.message}`);
        else notStarted(`could not be started: ${error.message}`);
      });
      forwardLines(child.stdout, (line) => this.#output.stdout(line));
      forwardLines(child.stderr, (line) => this.#output.stderr(line));
      // Emitted once the output has closed too, so the run's own lines all come before this one.
      child.once('close', (code, signal) => {
        if (ended) return;
        this.#output.stdout(
          signal === null
            ? `${PREFIX}the ${scenario} run exited with code ${code}`
            : `${PREFIX}the ${scenario} run ended on ${signal}`,
        );
        end(code, signal);
      });
      cancels.push(
        this.#schedule(() => {
          this.#output.stderr(`${PREFIX}the ${scenario} run has run for ${this.#maxRunSeconds} seconds: sending SIGTERM`);
          child.kill('SIGTERM');
          cancels.push(
            this.#schedule(() => {
              this.#output.stderr(
                `${PREFIX}the ${scenario} run is still going ${KILL_GRACE_MS / 1000} seconds after SIGTERM: sending SIGKILL`,
              );
              child.kill('SIGKILL');
            }, KILL_GRACE_MS),
          );
        }, this.#maxRunSeconds * 1000),
      );
    });
  }
}
