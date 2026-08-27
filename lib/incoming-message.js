const { Readable } = require('bare-stream')
const HTTPMessage = require('./message')
const { bag, normalize } = require('./headers')

module.exports = class HTTPIncomingMessage extends HTTPMessage(Readable) {
  constructor(socket = null, opts = {}) {
    super(socket)

    // Whether the message has let go of the socket, which happens as soon as
    // the whole of it has arrived.
    this._detached = false

    this._headers = opts.headers || bag()
    this._httpVersion = opts.httpVersion || '1.1'

    // Server options
    this._method = opts.method || ''
    this._url = opts.url || ''

    // Client options
    this._statusCode = opts.statusCode || 0
    this._statusMessage = opts.statusMessage || ''

    // Called when the consumer is ready for more of the body, so that the
    // connection it came from can go back to reading the socket.
    this._demand = null
  }

  get headers() {
    return this._headers
  }

  set headers(value) {
    this._headers = normalize(value)
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
    return this._httpVersion
  }

  _read() {
    if (this._demand) this._demand()
  }

  _predestroy() {
    if (this._upgrade === false && this._detached === false && this._socket !== null) {
      this._socket.destroy()
    }
  }
}
