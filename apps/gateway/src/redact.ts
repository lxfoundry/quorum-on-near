import type { Writable } from 'node:stream';

/**
 * The variables whose value is a URL that may hold a key: the gateway's RPC URL and a demo run's. Some
 * RPC providers put their key in the URL's path, which no check can tell from a path.
 */
export const SECRET_URL_VARIABLES: readonly string[] = ['QUORUM_RPC_URL', 'QUORUM_DEMO_RPC_URL'];

/** Secret URLs by the name of the variable that holds each; a value may be unset. */
export type SecretUrls = Readonly<Record<string, string | undefined>>;

/** The value of each of SECRET_URL_VARIABLES in `env`. */
export function secretUrls(env: Readonly<Record<string, string | undefined>>): SecretUrls {
  return Object.fromEntries(SECRET_URL_VARIABLES.map((name) => [name, env[name]]));
}

/**
 * `text` with each secret URL replaced by the name of its variable, as the URL is written four ways:
 * as written, as the URL parser writes it (`new URL(value).href`, which lower-cases the host and drops
 * a default port), and each of those without its trailing slashes. The longest form of all the URLs
 * goes first, so that no piece of a URL that starts with another is left. A value that is unset,
 * empty or not a URL changes nothing.
 */
export function redactUrls(text: string, secrets: SecretUrls): string {
  const names = new Map<string, string>();
  for (const [name, value] of Object.entries(secrets)) {
    if (value === undefined || !URL.canParse(value)) continue;
    const { href } = new URL(value);
    for (const form of [value, value.replace(/\/+$/, ''), href, href.replace(/\/+$/, '')]) {
      if (form !== '' && !names.has(form)) names.set(form, name);
    }
  }
  const replacements = [...names].sort(([a], [b]) => b.length - a.length);
  return replacements.reduce((redacted, [form, name]) => redacted.replaceAll(form, name), text);
}

/**
 * Has `stream.write` pass each chunk through `redact` first: a string, or a Uint8Array (a Buffer
 * included) read as UTF-8 and then written as that text, without the encoding given for its bytes.
 * A chunk that `redact` leaves as it is goes on unchanged. The callback and the return value are the
 * stream's own.
 */
export function redactWrites(stream: Pick<Writable, 'write'>, redact: (text: string) => string): void {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string') return write(redact(chunk), ...rest);
    if (chunk instanceof Uint8Array) {
      const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
      const redacted = redact(text);
      // The bytes are now text, which an encoding given for them does not describe.
      if (redacted !== text) return write(redacted, ...rest.filter((arg) => typeof arg === 'function'));
    }
    return write(chunk, ...rest);
  }) as Writable['write'];
}

/**
 * Replaces the secret URLs that `env` holds (see redactUrls) in everything the process writes from
 * now on to its standard output and error: console lines, direct writes, libraries' own lines and
 * Node's warnings. A provider may put its key in its URL, even in the path, and library errors and
 * providers' messages quote that URL: near-api-js writes `<url> Bad Gateway`, and makes an RPC's error
 * text its error's message.
 *
 * Node reports an uncaught error past the stream, so such an error is reported through console.error
 * instead, and ends the process with code 1. Under Node's default `--unhandled-rejections=throw`, an
 * unhandled rejection, a rejected top-level await included, is reported the same way.
 *
 * What it misses: a key quoted alone rather than inside its URL, or a piece of the URL, such as the
 * few characters of a body that a JSON parse error quotes; a URL split across two writes; a URL
 * written in a fifth form, such as percent-encoded or escaped; a key in the host itself, which the
 * gateway prints alone when it cannot read the chain id; anything written straight to file
 * descriptors 1 and 2 rather than through the two streams, for example with `fs.writeSync` or
 * `process._rawDebug`; and Node's own report of an error thrown inside the uncaught-error listener
 * itself.
 */
export function redactProcessOutput(env: Readonly<Record<string, string | undefined>> = process.env): void {
  const secrets = secretUrls(env);
  const redact = (text: string): string => redactUrls(text, secrets);
  redactWrites(process.stdout, redact);
  redactWrites(process.stderr, redact);
  process.on('uncaughtException', (error) => {
    console.error('uncaught error:', error);
    process.exit(1);
  });
}
