module.exports = class HTTP1Error extends Error {
  constructor (msg, code, fn = HTTP1Error) {
    super(`${code}: ${msg}`)
    this.code = code

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, fn)
    }
  }

  get name () {
    return 'HTTP1Error'
  }

  static CONNECTION_LOST (msg = 'Socket hang up') {
    return new HTTP1Error(msg, 'CONNECTION_LOST', HTTP1Error.CONNECTION_LOST)
  }
}
