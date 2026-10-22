/**
 * Generic client errors for Cloud routes.
 *
 * A client sees a code, a plain message and a request id. The cause, which can
 * name environment variables or say how the operator fixes it, goes to the
 * server log under the same id. Nothing in the response names server config.
 */

export interface GenericErrorOptions {
  status: number;
  code: string;
  /** Safe for the client: no variable names, values or fix steps for the operator. */
  message: string;
  retryable: boolean;
  /** The detailed cause, for the server log only. */
  cause: string;
  /** Receives one line carrying the request id and the cause. Defaults to console.error. */
  log?: (line: string) => void;
}

export function genericError(opts: GenericErrorOptions): Response {
  const requestId = crypto.randomUUID();
  const log = opts.log ?? ((line: string) => console.error(line));
  log(`${opts.code}: request ${requestId}: ${opts.cause}`);
  const body = {
    error: {
      code: opts.code,
      message: opts.message,
      retryable: opts.retryable,
      fix: { note: `Quote request id ${requestId} to the operator; the cause is in the server log.` },
    },
    requestId,
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: opts.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId },
  });
}
