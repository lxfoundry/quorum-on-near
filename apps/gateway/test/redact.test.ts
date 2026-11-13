import { execFile } from 'node:child_process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { redactUrls, redactWrites, secretUrls } from '../src/redact.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/redact-output.ts', import.meta.url));
/** An RPC URL with a fake key in its path, where some providers put a real one. */
const PATH_URL = 'https://rpc.example/v2/fake-key-0123456789abcdef/';
/** Any piece of that key. */
const KEY = /fake-key|0123456789abcdef/;

describe('redactUrls', () => {
  // An upper-case host and the default port: the URL parser writes this URL another way.
  const WRITTEN = 'https://RPC.Example:443/v2/fake-key-0123456789abcdef/';

  it.each([
    ['as written', WRITTEN],
    ['as written, without its trailing slash', 'https://RPC.Example:443/v2/fake-key-0123456789abcdef'],
    ['as the URL parser writes it', 'https://rpc.example/v2/fake-key-0123456789abcdef/'],
    ['as the URL parser writes it, without its trailing slash', 'https://rpc.example/v2/fake-key-0123456789abcdef'],
  ])('replaces the URL %s with the name of its variable', (_label, form) => {
    expect(redactUrls(`node behind ${form} failed`, { QUORUM_RPC_URL: WRITTEN })).toBe('node behind QUORUM_RPC_URL failed');
  });

  it.each([
    ['its path', PATH_URL],
    ['its query', 'https://rpc.example/?apiKey=fake-key-0123456789abcdef'],
    ['its user name and password', 'https://user:fake-key-0123456789abcdef@rpc.example/'],
  ])('leaves nothing of a key in %s', (_label, url) => {
    expect(redactUrls(`${url} Bad Gateway`, { QUORUM_RPC_URL: url })).toBe('QUORUM_RPC_URL Bad Gateway');
  });

  it('leaves text that holds no secret URL as it is, the host alone included', () => {
    const text = 'cannot read the chain id from the RPC at rpc.example: fetch failed';
    expect(redactUrls(text, { QUORUM_RPC_URL: PATH_URL })).toBe(text);
  });

  it('replaces every occurrence', () => {
    expect(redactUrls(`${PATH_URL} Bad Gateway (from ${PATH_URL})`, { QUORUM_RPC_URL: PATH_URL })).toBe(
      'QUORUM_RPC_URL Bad Gateway (from QUORUM_RPC_URL)',
    );
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not a URL', 'not a url'],
  ])('changes nothing for a variable that is %s', (_label, value) => {
    const text = `not a url, then ${PATH_URL}`;
    expect(redactUrls(text, { QUORUM_RPC_URL: value })).toBe(text);
  });

  it('replaces a URL that starts with another whole, whatever the order of their variables', () => {
    const short = 'https://rpc.example/?apiKey=fake-key';
    const long = 'https://rpc.example/?apiKey=fake-key-0123456789abcdef';
    const text = `${long} and ${short}`;
    expect(redactUrls(text, { QUORUM_RPC_URL: short, ARCHIVE_RPC_URL: long })).toBe('ARCHIVE_RPC_URL and QUORUM_RPC_URL');
    expect(redactUrls(text, { ARCHIVE_RPC_URL: long, QUORUM_RPC_URL: short })).toBe('ARCHIVE_RPC_URL and QUORUM_RPC_URL');
  });
});

describe('secretUrls', () => {
  /** The RPC URL of a demo run, with a fake key in its query. */
  const DEMO_URL = 'https://rpc.demo.example/?apiKey=fake-key-0123456789abcdef';

  it('takes each secret URL from the environment it is given, and nothing else', () => {
    const env = {
      QUORUM_RPC_URL: PATH_URL,
      QUORUM_DEMO_RPC_URL: DEMO_URL,
      QUORUM_GATEWAY_URL: 'http://localhost:8402',
      QUORUM_PARENT_ACCOUNT: 'parent.testnet',
    };
    expect(secretUrls(env)).toStrictEqual({ QUORUM_RPC_URL: PATH_URL, QUORUM_DEMO_RPC_URL: DEMO_URL });
  });

  it("replaces a demo run's RPC URL with its own variable's name", () => {
    const text = `${DEMO_URL} Bad Gateway, then ${PATH_URL} Bad Gateway`;
    expect(redactUrls(text, secretUrls({ QUORUM_RPC_URL: PATH_URL, QUORUM_DEMO_RPC_URL: DEMO_URL }))).toBe(
      'QUORUM_DEMO_RPC_URL Bad Gateway, then QUORUM_RPC_URL Bad Gateway',
    );
  });
});

describe('redactWrites', () => {
  /** A Writable that keeps the bytes it is given, wrapped by redactWrites with PATH_URL as the secret. */
  function sink() {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    redactWrites(stream, (text) => redactUrls(text, { QUORUM_RPC_URL: PATH_URL }));
    return { stream, text: () => Buffer.concat(chunks).toString('utf8'), chunks };
  }

  it('redacts a string', () => {
    const { stream, text } = sink();
    stream.write(`at ${PATH_URL}\n`);
    expect(text()).toBe('at QUORUM_RPC_URL\n');
  });

  it('redacts a Buffer and a Uint8Array, read as UTF-8', () => {
    const { stream, text } = sink();
    stream.write(Buffer.from(`é ${PATH_URL}\n`));
    // A view into a larger buffer: only its own bytes are read.
    stream.write(new TextEncoder().encode(`xx${PATH_URL}xx`).subarray(2, -2));
    expect(text()).toBe('é QUORUM_RPC_URL\nQUORUM_RPC_URL');
  });

  it('passes the callback on', async () => {
    const { stream, text } = sink();
    await new Promise((resolve) => stream.write(PATH_URL, resolve));
    expect(text()).toBe('QUORUM_RPC_URL');
  });

  it("passes a string's encoding on, with the callback", async () => {
    const { stream, text } = sink();
    // Written as the text "6869" if the encoding were lost.
    await new Promise((resolve) => stream.write('6869', 'hex', resolve));
    await new Promise((resolve) => stream.write(PATH_URL, 'utf8', resolve));
    expect(text()).toBe('hiQUORUM_RPC_URL');
  });

  it('drops the encoding given with a Buffer it turns into text, and passes the callback on', async () => {
    const { stream, text } = sink();
    // Kept with the text, latin1 would write é as one byte that is not UTF-8.
    await new Promise((resolve) => stream.write(Buffer.from(`é ${PATH_URL}`), 'latin1', resolve));
    expect(text()).toBe('é QUORUM_RPC_URL');
  });

  it('passes a Buffer that holds no secret URL on as it is, bytes that are not UTF-8 included', () => {
    const { stream, chunks } = sink();
    const bytes = Buffer.from([0xff, 0xe2, 0x82]);
    stream.write(bytes);
    expect(chunks).toEqual([bytes]);
  });

  it("returns what the stream's own write returns", () => {
    // A stream that never finishes a write, so all it is given counts against its high-water mark.
    const stream = new Writable({ highWaterMark: 8, write: () => {} });
    redactWrites(stream, (text) => redactUrls(text, { QUORUM_RPC_URL: PATH_URL }));
    expect(stream.write('ok')).toBe(true);
    // QUORUM_RPC_URL's 14 bytes pass the high-water mark: the writer should wait for 'drain'.
    expect(stream.write(PATH_URL)).toBe(false);
  });
});

// The 60-second test timeout is above the child's own 30-second one, so that a slow child is killed and
// reported with its output, not lost when the test times out.
describe('redactProcessOutput', { timeout: 60_000 }, () => {
  /** Runs the fixture with QUORUM_RPC_URL set to PATH_URL, ending as `ending` says. */
  function runFixture(ending: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const options = { env: { ...process.env, QUORUM_RPC_URL: PATH_URL }, timeout: 30_000 };
      const child = execFile(process.execPath, [FIXTURE, ending], options, (_, stdout, stderr) =>
        resolve({ code: child.exitCode, stdout, stderr }),
      );
    });
  }

  it.each([
    ['an error thrown', 'throw'],
    ['a rejected top-level await', 'await'],
    ['an unhandled rejection', 'reject'],
  ])('keeps the URL out of all that a process writes, up to %s, which ends it with code 1', async (_label, ending) => {
    const { code, stdout, stderr } = await runFixture(ending);
    expect(code, stderr).toBe(1);
    expect(stdout).toContain('console.log QUORUM_RPC_URL\n');
    expect(stdout).toContain('process.stdout.write QUORUM_RPC_URL\n');
    expect(stderr).toContain('Error: console.error QUORUM_RPC_URL\n');
    expect(stderr).toContain('[cause]: Error: QUORUM_RPC_URL\n');
    expect(stderr).toContain('process.stderr.write QUORUM_RPC_URL\n');
    expect(stderr).toContain(`Error: ${ending} QUORUM_RPC_URL\n`);
    expect(stdout).not.toMatch(KEY);
    expect(stderr).not.toMatch(KEY);
  });
});
