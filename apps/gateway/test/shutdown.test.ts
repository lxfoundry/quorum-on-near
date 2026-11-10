import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { gracefulClose } from '../src/shutdown.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Longer than any test: a connection the tests see closing was closed by the server, not timed out. */
const KEEP_ALIVE_MS = 60_000;
/** How long a test waits for a connection to close. */
const CLOSE_WAIT_MS = 2_000;

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.closeAllConnections();
});

/** A server on a free local port, with `gracefulClose` set up before it takes a request. */
async function start(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  servers.push(server);
  const close = gracefulClose(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, port, close };
}

/** A keep-alive HTTP/1.1 client on a raw socket, which records everything it receives. */
async function client(port: number) {
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  socket.setEncoding('utf8');
  let received = '';
  const arrivals: Array<() => void> = [];
  socket.on('data', (chunk: string) => {
    received += chunk;
    for (const arrival of arrivals.splice(0)) arrival();
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  await once(socket, 'connect');
  return {
    socket,
    received: () => received,
    /** Resolves once `text` has been received. */
    async until(text: string): Promise<void> {
      while (!received.includes(text)) await new Promise<void>((resolve) => arrivals.push(resolve));
    },
    /** Whether the server closes the connection within CLOSE_WAIT_MS. */
    closesSoon: () =>
      Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CLOSE_WAIT_MS)),
      ]),
  };
}

const REQUEST = 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n';

describe('gracefulClose', () => {
  it('answers the request a connection is busy with at close time, then closes that connection', async () => {
    const arrived = deferred<void>();
    const answer = deferred<void>();
    const { server, port, close } = await start(async (_request, response) => {
      arrived.resolve();
      await answer.promise;
      response.end('done');
    });
    const serverClosed = once(server, 'close');
    const c = await client(port);
    c.socket.write(REQUEST);
    await arrived.promise;

    close();
    answer.resolve();
    await c.until('done');
    expect(c.received()).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(c.received()).toMatch(/\r\nConnection: close\r\n/i);
    expect(await c.closesSoon()).toBe(true);
    await serverClosed;
  });

  it('closes a connection once its response ends, when the response had started at close time', async () => {
    const answer = deferred<void>();
    const { server, port, close } = await start(async (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('start;');
      await answer.promise;
      response.end('end');
    });
    const serverClosed = once(server, 'close');
    const c = await client(port);
    c.socket.write(REQUEST);
    await c.until('start;');

    close();
    answer.resolve();
    expect(await c.closesSoon()).toBe(true);
    expect(c.received()).toContain('end');
    await serverClosed;
  });

  it('answers a request whose headers were still arriving at close time, then closes its connection', async () => {
    let serverSocket: Socket | undefined;
    const { server, port, close } = await start((_request, response) => {
      response.end('done');
    });
    server.once('connection', (socket: Socket) => {
      serverSocket = socket;
    });
    const serverClosed = once(server, 'close');
    const c = await client(port);
    c.socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
    while ((serverSocket?.bytesRead ?? 0) === 0) await new Promise<void>((resolve) => setImmediate(resolve));

    close();
    c.socket.write('\r\n');
    await c.until('done');
    expect(c.received()).toMatch(/\r\nConnection: close\r\n/i);
    expect(await c.closesSoon()).toBe(true);
    await serverClosed;
  });

  it('drops a connection that is idle at close time', async () => {
    const { server, port, close } = await start((_request, response) => {
      response.end('done');
    });
    const serverClosed = once(server, 'close');
    const c = await client(port);
    c.socket.write(REQUEST);
    await c.until('done');

    close();
    expect(await c.closesSoon()).toBe(true);
    await serverClosed;
  });
});
