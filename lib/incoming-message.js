const { Readable } = require('bare-stream')

module.exports = class HTTPIncomingMessage extends Readable {
  constructor(socket = null, headers = {}, opts = {}) {
    super()

    this._socket = socket
    this._headers = headers
    this._upgrade = false

    // Server options
    this._method = opts.method || ''
    this._url = opts.url || ''

    // Client options
    this._statusCode = opts.statusCode || 0
    this._statusMessage = opts.statusMessage || ''
  }

  get socket() {
    return this._socket
  }

  get headers() {
    return this._headers
  }

  get upgrade() {
    return this._upgrade
  }

  get method() {
    return this._method
  }

  get url() {
    return this._url
  }

  get statusCode() {
    return this._statusCode
  }

  get statusMessage() {
    return this._statusMessage
  }

  get httpVersion() {
    return '1.1'
  }

  getHeader(name) {
    return this._headers[name.toLowerCase()]
  }

  getHeaders() {
    return { ...this._headers }
  }

  hasHeader(name) {
    return name.toLowerCase() in this._headers
  }

  setTimeout(ms, ontimeout) {
    if (ontimeout) this.once('timeout', ontimeout)

    this._socket.setTimeout(ms)

    return this
  }

  _predestroy() {
    if (this._upgrade === false && this._socket !== null) this._socket.destroy()
  }
}
