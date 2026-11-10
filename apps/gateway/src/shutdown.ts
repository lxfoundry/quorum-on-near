import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/**
 * Sets `server` up to close without keeping any connection alive, and returns the function that
 * closes it. Call it before the server takes a request.
 *
 * Node's server.close() stops listening and drops the connections that are idle at that moment. A
 * connection busy with a request answers it with keep-alive, and a client that sends its next
 * request in time is served again, and so on: the server never closes. Once the returned function
 * has been called, every response not yet started closes its connection once sent, and a connection
 * whose response had already started is dropped once that response ends. No connection is cut while
 * it carries a request, so the server closes once the running requests are answered.
 */
export function gracefulClose(server: Server): () => void {
  /** Responses to requests that arrived before the close, until each is sent or its connection drops. */
  const open = new Set<ServerResponse>();
  let closing = false;
  // First, so that no other listener has started the response.
  server.prependListener('request', (_request: IncomingMessage, response: ServerResponse) => {
    if (closing) {
      response.shouldKeepAlive = false;
      return;
    }
    open.add(response);
    response.once('close', () => open.delete(response));
  });
  return () => {
    closing = true;
    for (const response of open) {
      if (!response.headersSent) response.shouldKeepAlive = false;
      // Its headers promised keep-alive: once it ends, its connection is idle and can be dropped.
      else response.once('finish', () => server.closeIdleConnections());
    }
    server.close();
  };
}
