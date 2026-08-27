module.exports = class HTTPError extends Error {
  constructor(msg, fn = HTTPError, code = fn.name) {
    super(`${code}: ${msg}`)
    this.code = code

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, fn)
    }
  }

  get name() {
    return 'HTTPError'
  }

  static NOT_IMPLEMENTED(msg = 'Method not implemented') {
    return new HTTPError(msg, HTTPError.NOT_IMPLEMENTED)
  }

  static CONNECTION_LOST(msg = 'Socket hung up') {
    return new HTTPError(msg, HTTPError.CONNECTION_LOST)
  }

  static AGENT_SUSPENDED(msg = 'Agent is suspended') {
    return new HTTPError(msg, HTTPError.AGENT_SUSPENDED)
  }

  static INVALID_HEADER_NAME(msg = 'Invalid header name') {
    return new HTTPError(msg, HTTPError.INVALID_HEADER_NAME)
  }

  static INVALID_HEADER_VALUE(msg = 'Invalid header value') {
    return new HTTPError(msg, HTTPError.INVALID_HEADER_VALUE)
  }

  static INVALID_STATUS_CODE(msg = 'Invalid status code') {
    return new HTTPError(msg, HTTPError.INVALID_STATUS_CODE)
  }

  static HEADERS_SENT(msg = 'Headers have already been sent') {
    return new HTTPError(msg, HTTPError.HEADERS_SENT)
  }
}
