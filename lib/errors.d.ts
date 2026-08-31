/**
 * An error thrown by `bare-http1` for protocol-level failures, such as an unimplemented method, a
 * lost connection, a suspended agent, or an invalid header. Carries a `code` identifying the
 * specific failure.
 */
declare class HTTPError extends Error {
  readonly code: string
}

export = HTTPError
