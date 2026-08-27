const { Writable, Duplex } = require('bare-stream')
const errors = require('./errors')
const { normalize } = require('./headers')
const validate = require('./validate')

module.exports = exports = HTTPOutgoingMessage(Writable)

exports.Duplex = HTTPOutgoingMessage(Duplex)

function HTTPOutgoingMessage(Stream) {
  return class HTTPOutgoingMessage extends Stream {
    constructor(socket = null) {
      super()

      this._socket = socket
      this._upgrade = false
      this._headersSent = false
      this._headers = {}

      // Whether the body is framed with chunked transfer encoding. Decided when
      // the headers are flushed, as a body that is written in one go can be
      // framed with a content length instead.
      this._chunked = false
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
      if (this._headersSent) throw errors.HEADERS_SENT()

      this._headers = normalize(value)
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
      if (this._headersSent) throw errors.HEADERS_SENT()

      const n = name.toLowerCase()

      validate.validateHeaderName(n)
      validate.validateHeaderValue(n, value)

      this._headers[n] = value
    }

    flushHeaders() {
      if (this._headersSent === true || this._socket === null) return

      this._socket.write(Buffer.from(this._header()))
      this._headersSent = true
    }

    write(data, encoding, cb) {
      if (this._headersSent === false && this._socket !== null) {
        this._frame()

        this.flushHeaders()
      }

      return super.write(data, encoding, cb)
    }

    setTimeout(ms, ontimeout) {
      if (ontimeout) this.once('timeout', ontimeout)

      if (this._socket !== null) this._socket.setTimeout(ms)

      return this
    }

    _frame(length = -1) {
      if (this.hasHeader('content-length')) return

      if (length === -1) this._chunked = true
      else this.setHeader('Content-Length', length.toString())
    }

    _header() {
      throw errors.NOT_IMPLEMENTED()
    }

    _predestroy() {
      if (this._upgrade === false && this._socket !== null) this._socket.destroy()
    }
  }
}
