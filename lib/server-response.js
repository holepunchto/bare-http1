const HTTPOutgoingMessage = require('./outgoing-message')
const constants = require('./constants')
const errors = require('./errors')
const { has, hasToken, serialize } = require('./headers')
const validate = require('./validate')

const CONTINUE = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n')

module.exports = class HTTPServerResponse extends HTTPOutgoingMessage {
  constructor(socket, req) {
    super(socket)

    this._req = req

    this._statusCode = 200
    this._statusMessage = null

    // HTTP/1.0 has neither chunked transfer encoding nor persistent connections
    // by default, so a body of unknown length can only be delimited by closing
    // the connection.
    this._chunkable = req.httpVersion !== '1.0'

    this._close =
      hasToken(req.headers.connection, 'close') ||
      (this._chunkable === false && hasToken(req.headers.connection, 'keep-alive') === false)

    // An HTTP/1.0 peer closes the connection unless it is told that this side
    // is keeping it, so asking for one is only half of the agreement.
    this._keepAlive = this._chunkable === false && this._close === false

    this._onlyHeaders = req.method === 'HEAD'
  }

  get req() {
    return this._req
  }

  get statusCode() {
    return this._statusCode
  }

  set statusCode(value) {
    validate.validateStatusCode(value)

    this._statusCode = value
  }

  get statusMessage() {
    return this._statusMessage
  }

  set statusMessage(value) {
    validate.validateStatusMessage(value)

    this._statusMessage = value
  }

  writeHead(statusCode, statusMessage = null, headers = {}) {
    if (this._headersSent) throw errors.HEADERS_SENT()

    if (typeof statusMessage === 'object' && statusMessage !== null) {
      headers = statusMessage
      statusMessage = null
    }

    validate.validateStatusCode(statusCode)

    if (statusMessage !== null) validate.validateStatusMessage(statusMessage)

    this._statusCode = statusCode
    this._statusMessage = statusMessage || null

    // Merged through the setter so that the names are lowercased. The fields
    // may be given as a bag, as a flat list of alternating names and values, or
    // as a list of pairs, all three of which Node.js accepts. An array is an
    // object, so the list forms have to be told apart from the bag first.
    if (Array.isArray(headers)) {
      if (headers.length > 0 && Array.isArray(headers[0])) {
        for (const [name, value] of headers) this.setHeader(name, value)
      } else {
        if (headers.length % 2 !== 0) {
          throw errors.INVALID_HEADER_VALUE('Header list must hold a value for every name')
        }

        for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1])
      }
    } else if (headers) {
      for (const name of Object.keys(headers)) this.setHeader(name, headers[name])
    }

    return this
  }

  writeContinue() {
    if (this._headersSent) throw errors.HEADERS_SENT()
    if (this._socket === null) return

    this._socket.write(CONTINUE)
  }

  _bodyless() {
    return this._statusCode < 200 || this._statusCode === 204 || this._statusCode === 304
  }

  _discardBody() {
    return this._onlyHeaders || this._bodyless()
  }

  _frame(length = -1) {
    // A message that may not carry a body must not announce one either, and
    // none is written for it, so there is nothing left to delimit. A 304 stands
    // in for a real response, so a length set for it describes the body it is
    // replacing and is left as it is.
    if (this._bodyless()) {
      this._chunked = false

      delete this._headers['transfer-encoding']

      if (this._statusCode !== 304) delete this._headers['content-length']
      else if (has(this._headers, 'content-length')) {
        // Never framed against a body, but the peer still reads it, so it has to
        // be a count of bytes and nothing else.
        this._headers['content-length'] = validate
          .validateContentLength(this._headers['content-length'])
          .toString()
      }

      return
    }

    if (this._reframe()) return

    if (length !== -1) return this._frameLength(length)

    // A response to HEAD never carries a body, so there is nothing to delimit:
    // announcing chunked would promise a terminator that is never written, and
    // closing would give up a connection that is still perfectly good.
    if (this._onlyHeaders) return

    // Without chunked encoding the only way to delimit a body of unknown length
    // is to close the connection once it has been written.
    if (this._chunkable) this._chunked = true
    else this._close = true
  }

  _header() {
    validate.validateStatusCode(this._statusCode)

    const statusMessage =
      this._statusMessage === null
        ? constants.status[this._statusCode] || 'unknown'
        : this._statusMessage

    validate.validateStatusMessage(statusMessage)

    let h = 'HTTP/1.1 ' + this._statusCode + ' ' + statusMessage + '\r\n'

    let connection = false

    for (const name of Object.keys(this._headers)) {
      const n = name.toLowerCase()
      const v = this._headers[name]

      validate.validateHeaderName(n)
      validate.validateHeaderValue(n, v)

      if (n === 'connection') {
        connection = true

        if (hasToken(v, 'close')) this._close = true
      }

      h += serialize(n, v)
    }

    if (this._chunked) h += 'Transfer-Encoding: chunked\r\n'

    // The peer has no other way of knowing where an unframed body ends, or that
    // the connection is not going to be reused.
    if (connection === false) {
      if (this._close) h += 'Connection: close\r\n'
      else if (this._keepAlive) h += 'Connection: keep-alive\r\n'
    }

    if (has(this._headers, 'date') === false) {
      h += 'Date: ' + new Date().toUTCString() + '\r\n'
    }

    h += '\r\n'

    return h
  }

  _end() {
    if (this._close) this._socket.end()
  }

  _predestroy() {
    super._predestroy()

    this._req.destroy()
  }
}
