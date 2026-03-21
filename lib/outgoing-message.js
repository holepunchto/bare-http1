const { Writable } = require('bare-stream')
const errors = require('./errors')

module.exports = class HTTPOutgoingMessage extends Writable {
  constructor(socket = null) {
    super()

    this._socket = socket
    this._upgrade = false
    this._headersSent = false
    this._headers = {}
  }

  get socket() {
    return this._socket
  }

  get upgrade() {
    return this._upgrade
  }

  get headersSent() {
    return this._headersSent
  }

  get headers() {
    return this._headers
  }

  set headers(value) {
    this._headers = value
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

  setHeader(name, value) {
    this._headers[name.toLowerCase()] = value
  }

  flushHeaders() {
    if (this._headersSent === true || this._socket === null) return

    this._socket.write(Buffer.from(this._header()))
    this._headersSent = true
  }

  setTimeout(ms, ontimeout) {
    if (ontimeout) this.once('timeout', ontimeout)

    this._socket.setTimeout(ms)

    return this
  }

  _header() {
    throw errors.NOT_IMPLEMENTED()
  }

  _predestroy() {
    if (this._upgrade === false && this._socket !== null) this._socket.destroy()
  }
}
