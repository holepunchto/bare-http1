const { isFinishing } = require('bare-stream')
const HTTPOutgoingMessage = require('./outgoing-message')
const constants = require('./constants')

const CHUNK_DELIMITER = Buffer.from('\r\n')
const CHUNK_TERMINATOR = Buffer.from('0\r\n\r\n')

module.exports = class HTTPServerResponse extends HTTPOutgoingMessage {
  constructor(socket, req) {
    super(socket)

    this._req = req

    this._statusCode = 200
    this._statusMessage = null

    this._chunked = true
    this._close = req.headers.connection === 'close'
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
    this._statusCode = value
  }

  get statusMessage() {
    return this._statusMessage
  }

  set statusMessage(value) {
    this._statusMessage = value
  }

  writeHead(statusCode, statusMessage = null, headers = {}) {
    if (typeof statusMessage === 'object' && statusMessage !== null) {
      headers = statusMessage
      statusMessage = null
    }

    this._statusCode = statusCode
    this._statusMessage = statusMessage || null

    if (headers) this._headers = { ...this._headers, ...headers }
  }

  _header() {
    let h =
      'HTTP/1.1 ' +
      this._statusCode +
      ' ' +
      (this._statusMessage === null ? constants.status[this._statusCode] : this._statusMessage) +
      '\r\n'

    for (const name of Object.keys(this._headers)) {
      const n = name.toLowerCase()
      const v = this._headers[name]

      if (n === 'content-length') this._chunked = false
      if (n === 'connection' && v && v.toLowerCase() === 'close') this._close = true

      h += httpCase(n) + ': ' + v + '\r\n'
    }

    if (this._chunked) h += 'Transfer-Encoding: chunked\r\n'

    h += '\r\n'

    return h
  }

  _write(data, encoding, cb) {
    if (this._headersSent === false) {
      if (isFinishing(this)) {
        this.setHeader(
          'Content-Length',
          (data.byteLength + this._writableState.buffered).toString()
        )
      }

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
      this.setHeader('Content-Length', '0')
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
