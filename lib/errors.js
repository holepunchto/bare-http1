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
}
