const { Readable } = require('bare-stream')

module.exports = class HTTPIncomingMessage extends Readable {
  constructor(socket = null, opts = {}) {
    super()

    this._socket = socket
    this._upgrade = false
    this._headers = opts.headers || {}

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

  get upgrade() {
    return this._upgrade
  }

  get headers() {
    return this._headers
  }

  set headers(value) {
    this._headers = value
  }

  get method() {
    return this._method
  }

  set method(value) {
    this._method = value
  }

  get url() {
    return this._url
  }

  set url(value) {
    this._url = value
  }

  get statusCode() {
    return this._statusCode
  }

  set statusCode(value) {
    this._statusCode = value
  }

  get statusMessage() {
    return this._statusMessage
  }

  set statusMessage(value) {
    this._statusMessage = value
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
