/** A handler's answer, independent of the HTTP framework. */
export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function reply(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return headers ? { status, body, headers } : { status, body };
}
