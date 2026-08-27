const { isFinishing } = require('bare-stream')
const HTTPOutgoingMessage = require('./outgoing-message')
const constants = require('./constants')
const errors = require('./errors')
const { hasToken } = require('./headers')
const validate = require('./validate')

const CHUNK_DELIMITER = Buffer.from('\r\n')
const CHUNK_TERMINATOR = Buffer.from('0\r\n\r\n')
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

    this._onlyHeaders = req.method === 'HEAD'

    this._pendingWrite = null
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

    // Merged through the setter so that the names are lowercased.
    if (headers) {
      for (const name of Object.keys(headers)) this.setHeader(name, headers[name])
    }
  }

  writeContinue() {
    if (this._headersSent) throw errors.HEADERS_SENT()
    if (this._socket === null) return

    this._socket.write(CONTINUE)
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

      h += httpCase(n) + ': ' + v + '\r\n'
    }

    if (this._chunked) h += 'Transfer-Encoding: chunked\r\n'

    // The peer has no other way of knowing where an unframed body ends, or that
    // the connection is not going to be reused.
    if (connection === false && this._close) h += 'Connection: close\r\n'

    if ('date' in this._headers === false) h += 'Date: ' + new Date().toUTCString() + '\r\n'

    h += '\r\n'

    return h
  }

  _frame(length = -1) {
    if (length !== -1) return super._frame(length)

    if (this.hasHeader('content-length')) return

    // Without chunked encoding the only way to delimit a body of unknown length
    // is to close the connection once it has been written.
    if (this._chunkable) this._chunked = true
    else this._close = true
  }

  _write(data, encoding, cb) {
    if (this._headersSent === false) {
      this._frame(bodyLength(this, data))

      this.flushHeaders()
    }

    if (this._onlyHeaders === true) return cb(null)

    if (this._chunked) {
      this._socket.write(Buffer.from(data.byteLength.toString(16)))
      this._socket.write(CHUNK_DELIMITER)
    }

    let flushed = this._socket.write(data)

    if (this._chunked) flushed = this._socket.write(CHUNK_DELIMITER)

    if (flushed) cb(null)
    else this._pendingWrite = cb
  }

  _final(cb) {
    if (this._headersSent === false) {
      // Nothing was written, so the body is empty.
      this._frame(0)

      this.flushHeaders()
    }

    if (this._chunked && this._onlyHeaders === false) this._socket.write(CHUNK_TERMINATOR)

    if (this._close) this._socket.end()

    cb(null)
  }

  _predestroy() {
    super._predestroy()

    this._req.destroy()

    this._continueWrite()
  }

  _continueWrite() {
    if (this._pendingWrite === null) return
    const cb = this._pendingWrite
    this._pendingWrite = null
    cb(null)
  }
}

function httpCase(n) {
  let s = ''
  for (const part of n.split('-')) {
    s += (s ? '-' : '') + part.slice(0, 1).toUpperCase() + part.slice(1)
  }
  return s
}

function bodyLength(message, data) {
  if (isFinishing(message) === false) return -1

  return data.byteLength + message._writableState.buffered
}
