import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  DemoRunner,
  type DemoOutput,
  type DemoRunnerOptions,
  type DemoScenario,
  type Schedule,
  type Spawn,
} from '../src/demo.ts';

/** The stand-in for the swarm's demo command (its modes are listed in the file). */
const PROGRAM = fileURLToPath(new URL('./fixtures/demo-program.mjs', import.meta.url));
/** 2030-01-01 at 12:00 UTC. */
const NOON = Date.UTC(2030, 0, 1, 12);
/** How long a test waits for the program: starting Node takes a few hundred milliseconds. */
const WAIT = { timeout: 5_000, interval: 10 };
/** The gateway's own RPC URL, in the tests of a run's environment. */
const GATEWAY_RPC_URL = 'https://rpc.gateway.example/';
/** The RPC URL a run gets in place of the gateway's, with a fake key in its query. */
const DEMO_RPC_URL = 'https://rpc.demo.example/?apiKey=fake-key-0123456789abcdef';

/** This process's environment without its QUORUM_* variables, whatever their case. */
function withoutQuorum(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^quorum_/i.test(name)));
}

/** An output that keeps every line the runner writes, by stream. */
interface Collected extends DemoOutput {
  out: string[];
  err: string[];
}

function collect(): Collected {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line) };
}

interface ManualTimer {
  ms: number;
  run: () => void;
  cancelled: boolean;
}

/** A Schedule whose timers run only when the test fires them. */
function manualSchedule(): { schedule: Schedule; timers: ManualTimer[] } {
  const timers: ManualTimer[] = [];
  const schedule: Schedule = (run, ms) => {
    const timer: ManualTimer = { ms, run, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return { schedule, timers };
}

/** Runs the timer at `index`, which the runner must have scheduled. */
function fire(timers: ManualTimer[], index: number): void {
  const timer = timers[index];
  if (timer === undefined) throw new Error(`no timer ${index}: ${timers.length} scheduled`);
  timer.run();
}

/**
 * A runner of the stand-in program in `mode`, 100 runs a day and 1800 seconds a run unless `options`
 * says otherwise, over a clock the test moves. Once the test has finished, no run is left in progress.
 */
function runner(mode: string[], options: Partial<DemoRunnerOptions> = {}) {
  const output = collect();
  const clock = { now: NOON };
  const demo = new DemoRunner({
    command: [process.execPath, PROGRAM, ...mode],
    maxRunsPerDay: 100,
    maxRunSeconds: 1800,
    now: () => clock.now,
    output,
    ...options,
  });
  onTestFinished(async () => {
    demo.stop();
    await vi.waitFor(() => expect(demo.status().running).toBe(false), WAIT);
  });
  return { demo, output, clock };
}

/** Takes the slot, or fails the test. */
function claimed(demo: DemoRunner, scenario: DemoScenario = 'fills') {
  const claim = demo.claim(scenario);
  if (claim.kind !== 'claimed') throw new Error(`expected the slot, got ${claim.kind}`);
  return claim;
}

/** What the program printed in its describe mode. */
function described(output: Collected): { argv: string[]; cwd: string; env: Record<string, string> } {
  const line = output.out.find((text) => text.startsWith('[demo] {'));
  if (line === undefined) throw new Error(`the program printed no description: ${JSON.stringify(output.out)}`);
  return JSON.parse(line.slice('[demo] '.length));
}

describe('DemoRunner', { timeout: 20_000 }, () => {
  it('needs a program', () => {
    expect(() => new DemoRunner({ command: [], maxRunsPerDay: 1, maxRunSeconds: 60 })).toThrow(
      'the demo command needs a program',
    );
  });

  describe('its slot', () => {
    it('reports no run before the first', () => {
      const { demo } = runner(['exit', '0']);
      expect(demo.status()).toEqual({
        running: false,
        scenario: null,
        startedAt: null,
        last: null,
        runsToday: 0,
        maxRunsPerDay: 100,
      });
    });

    it("is taken in the step that checks it: a second claim gets the first one's scenario and start", () => {
      const { demo } = runner(['exit', '0']);
      const first = claimed(demo, 'fails');
      expect(demo.claim('fills')).toEqual({ kind: 'running', scenario: 'fails', startedAt: NOON });
      expect(demo.status()).toMatchObject({ running: true, scenario: 'fails', startedAt: NOON, runsToday: 0 });
      first.release();
    });

    it('is free again once released, and a released claim is not counted', () => {
      const { demo } = runner(['exit', '0']);
      claimed(demo).release();
      expect(demo.status()).toEqual({
        running: false,
        scenario: null,
        startedAt: null,
        last: null,
        runsToday: 0,
        maxRunsPerDay: 100,
      });
      claimed(demo).release();
    });

    it('cannot be started or released twice', async () => {
      const { demo } = runner(['exit', '0']);
      const released = claimed(demo);
      released.release();
      expect(() => released.release()).toThrow('this demo claim was already started or released');
      expect(() => released.start()).toThrow('this demo claim was already started or released');
      const started = claimed(demo);
      const ended = started.start();
      expect(() => started.release()).toThrow('this demo claim was already started or released');
      expect(demo.status().running).toBe(true);
      await ended;
    });

    it('counts a run when it starts, and holds the slot until the run has ended', async () => {
      const { demo, clock } = runner(['exit', '0']);
      const ended = claimed(demo).start();
      expect(demo.status()).toEqual({
        running: true,
        scenario: 'fills',
        startedAt: NOON,
        last: null,
        runsToday: 1,
        maxRunsPerDay: 100,
      });
      clock.now = NOON + 2_000;
      const last = { scenario: 'fills', startedAt: NOON, endedAt: NOON + 2_000, exitCode: 0, signal: null };
      expect(await ended).toEqual(last);
      expect(demo.status()).toEqual({
        running: false,
        scenario: null,
        startedAt: null,
        last,
        runsToday: 1,
        maxRunsPerDay: 100,
      });
    });

    it("answers running before the day's cap, and limit once the run has ended", async () => {
      const { demo } = runner(['exit', '0'], { maxRunsPerDay: 1 });
      const ended = claimed(demo).start();
      expect(demo.claim('fails')).toEqual({ kind: 'running', scenario: 'fills', startedAt: NOON });
      await ended;
      expect(demo.claim('fails')).toEqual({ kind: 'limit' });
      expect(demo.status()).toMatchObject({ running: false, runsToday: 1, maxRunsPerDay: 1 });
    });

    it('counts from 0 again after midnight UTC', async () => {
      const { demo, clock } = runner(['exit', '0'], { maxRunsPerDay: 1 });
      clock.now = Date.UTC(2030, 0, 1, 23, 59, 59, 999);
      await claimed(demo).start();
      expect(demo.claim('fills')).toEqual({ kind: 'limit' });
      clock.now = Date.UTC(2030, 0, 2);
      expect(demo.status().runsToday).toBe(0);
      await claimed(demo).start();
      expect(demo.status().runsToday).toBe(1);
    });
  });

  describe('a run', () => {
    it("starts the command, then the scenario, without a shell, in the gateway's folder", async () => {
      // A shell would expand $HOME and split the argument at the semicolon.
      const { demo, output } = runner(['describe', '$HOME; echo split']);
      await claimed(demo, 'fails').start();
      expect(described(output)).toMatchObject({ argv: ['describe', '$HOME; echo split', 'fails'], cwd: process.cwd() });
    });

    it('gives the run the environment it is given, without the relayer keys, the credential key or the phrase', async () => {
      const env = {
        ...withoutQuorum(),
        QUORUM_GATEWAY_URL: 'https://gateway.example',
        QUORUM_CREDENTIALS_DIR: '/run/quorum/credentials',
        QUORUM_RELAYER_KEYS: 'withheld-1',
        QUORUM_CREDENTIAL_JWK: 'withheld-2',
        QUORUM_SEED_PHRASE: 'withheld-3',
        QUORUM_SEED_PHRASE_FILE: 'withheld-4',
        // Windows reads variable names without case, so this would be QUORUM_SEED_PHRASE there.
        quorum_seed_phrase: 'withheld-5',
      };
      const { demo, output } = runner(['describe'], { env });
      await claimed(demo).start();
      expect(described(output).env).toEqual({
        QUORUM_GATEWAY_URL: 'https://gateway.example',
        QUORUM_CREDENTIALS_DIR: '/run/quorum/credentials',
      });
    });

    it("gives the run its own RPC URL as its QUORUM_RPC_URL, in place of the gateway's, and never QUORUM_DEMO_RPC_URL", async () => {
      const env = {
        ...withoutQuorum(),
        QUORUM_RPC_URL: GATEWAY_RPC_URL,
        QUORUM_DEMO_RPC_URL: DEMO_RPC_URL,
        // Windows reads variable names without case, so these would be the two above there.
        quorum_rpc_url: GATEWAY_RPC_URL,
        quorum_demo_rpc_url: DEMO_RPC_URL,
      };
      const { demo, output } = runner(['describe'], { env, rpcUrl: DEMO_RPC_URL });
      await claimed(demo).start();
      expect(described(output).env).toEqual({ QUORUM_RPC_URL: DEMO_RPC_URL });
    });

    it("gives the run the gateway's QUORUM_RPC_URL when it has no RPC URL of its own, and never QUORUM_DEMO_RPC_URL", async () => {
      const env = { ...withoutQuorum(), QUORUM_RPC_URL: GATEWAY_RPC_URL, QUORUM_DEMO_RPC_URL: '' };
      const { demo, output } = runner(['describe'], { env, rpcUrl: null });
      await claimed(demo).start();
      expect(described(output).env).toEqual({ QUORUM_RPC_URL: GATEWAY_RPC_URL });
    });

    it("never writes the run's own RPC URL in the runner's lines", async () => {
      // Not in describe mode, whose program writes its environment.
      const { demo, output } = runner(['exit', '3'], { rpcUrl: DEMO_RPC_URL });
      await claimed(demo, 'fails').start();
      expect(output.out.at(-1)).toBe('[demo] the fails run exited with code 3');
      for (const line of [...output.out, ...output.err]) expect(line).not.toMatch(/rpc\.demo\.example|fake-key/);
    });

    it('writes each line of its output prefixed, and a last line without a newline once the output closes', async () => {
      const { demo, output } = runner(['lines']);
      await claimed(demo).start();
      expect(output.out).toEqual([
        `[demo] starting the fills run: ${[process.execPath, PROGRAM, 'lines', 'fills'].join(' ')}`,
        '[demo] first line',
        '[demo] second line',
        '[demo] last line without a newline',
        '[demo] the fills run exited with code 0',
      ]);
      expect(output.err).toEqual(['[demo] an error line']);
    });

    it('records the exit code of a run that exits', async () => {
      const { demo, output, clock } = runner(['exit', '3']);
      const ended = claimed(demo, 'fails').start();
      clock.now = NOON + 60_000;
      const last = { scenario: 'fails', startedAt: NOON, endedAt: NOON + 60_000, exitCode: 3, signal: null };
      expect(await ended).toEqual(last);
      expect(demo.status()).toEqual({
        running: false,
        scenario: null,
        startedAt: null,
        last,
        runsToday: 1,
        maxRunsPerDay: 100,
      });
      expect(output.out.at(-1)).toBe('[demo] the fails run exited with code 3');
    });

    it('records both the exit code and the signal as null for a program that cannot be started, and counts it', async () => {
      const missing = fileURLToPath(new URL('./fixtures/no-such-program', import.meta.url));
      const { demo, output } = runner([], { command: [missing, 'demo'] });
      expect(await claimed(demo).start()).toMatchObject({ scenario: 'fills', exitCode: null, signal: null });
      expect(demo.status()).toMatchObject({ running: false, runsToday: 1 });
      expect(output.out).toEqual([`[demo] starting the fills run: ${missing} demo fills`]);
      expect(output.err).toEqual([expect.stringMatching(/^\[demo\] the fills run could not be started: .*ENOENT/)]);
    });

    it('records both as null when the program cannot even be spawned', async () => {
      const failing: Spawn = () => {
        throw new Error('spawn EINVAL');
      };
      const { demo, output } = runner(['exit', '0'], { spawn: failing });
      expect(await claimed(demo).start()).toMatchObject({ exitCode: null, signal: null });
      expect(output.err).toEqual(['[demo] the fills run could not be started: spawn EINVAL']);
      expect(demo.status()).toMatchObject({ running: false, runsToday: 1 });
    });

    it('sends SIGTERM once the run has lasted its maximum run time', async () => {
      const { schedule, timers } = manualSchedule();
      const { demo, output } = runner(['hang'], { schedule, maxRunSeconds: 60 });
      const ended = claimed(demo).start();
      expect(timers.map(({ ms }) => ms)).toEqual([60_000]);
      await vi.waitFor(() => expect(output.out).toContain('[demo] ready'), WAIT);
      fire(timers, 0);
      expect(await ended).toMatchObject({ exitCode: null, signal: 'SIGTERM' });
      expect(output.err).toEqual(['[demo] the fills run has run for 60 seconds: sending SIGTERM']);
      expect(output.out.at(-1)).toBe('[demo] the fills run ended on SIGTERM');
      // SIGKILL was scheduled 10 seconds after SIGTERM, and cancelled when the run ended.
      expect(timers.map(({ ms, cancelled }) => ({ ms, cancelled }))).toEqual([
        { ms: 60_000, cancelled: true },
        { ms: 10_000, cancelled: true },
      ]);
    });

    // Windows has no SIGTERM a program can catch: there, the run ends at the SIGTERM.
    it.skipIf(process.platform === 'win32')('sends SIGKILL 10 seconds after SIGTERM to a run that is still going', async () => {
      const { schedule, timers } = manualSchedule();
      const { demo, output } = runner(['ignore-sigterm'], { schedule, maxRunSeconds: 60 });
      const ended = claimed(demo).start();
      await vi.waitFor(() => expect(output.out).toContain('[demo] ready'), WAIT);
      fire(timers, 0);
      await vi.waitFor(() => expect(output.out).toContain('[demo] SIGTERM ignored'), WAIT);
      expect(timers[1]).toMatchObject({ ms: 10_000, cancelled: false });
      fire(timers, 1);
      expect(await ended).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
      expect(output.err).toEqual([
        '[demo] the fills run has run for 60 seconds: sending SIGTERM',
        '[demo] the fills run is still going 10 seconds after SIGTERM: sending SIGKILL',
      ]);
    });

    it('cancels the maximum run time once the run has ended', async () => {
      const { schedule, timers } = manualSchedule();
      const { demo } = runner(['exit', '0'], { schedule });
      await claimed(demo).start();
      expect(timers).toEqual([{ ms: 1_800_000, run: expect.any(Function), cancelled: true }]);
    });
  });

  describe('stop', () => {
    it('sends SIGTERM to a run in progress', async () => {
      const { demo, output } = runner(['hang']);
      const ended = claimed(demo, 'fails').start();
      await vi.waitFor(() => expect(output.out).toContain('[demo] ready'), WAIT);
      demo.stop();
      expect(await ended).toMatchObject({ scenario: 'fails', exitCode: null, signal: 'SIGTERM' });
      expect(output.err).toEqual(['[demo] the gateway is stopping: sending SIGTERM to the fails run']);
    });

    it('does nothing without a run', () => {
      const { demo, output } = runner(['exit', '0']);
      demo.stop();
      expect(demo.status()).toMatchObject({ running: false, last: null, runsToday: 0 });
      expect([...output.out, ...output.err]).toEqual([]);
    });

    it('keeps a run claimed before it from starting after it', async () => {
      const spawned = vi.fn<Spawn>(spawn);
      const { demo, output } = runner(['exit', '0'], { spawn: spawned });
      const claim = claimed(demo);
      demo.stop();
      expect(await claim.start()).toMatchObject({ exitCode: null, signal: null });
      expect(spawned).not.toHaveBeenCalled();
      expect(output.err).toEqual(['[demo] the fills run is not started: the gateway is stopping']);
    });
  });
});
