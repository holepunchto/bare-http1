const { isFinishing } = require('bare-stream')
const HTTPAgent = require('./agent')
const HTTPOutgoingMessage = require('./outgoing-message').Duplex
const { hasToken, normalize } = require('./headers')
const validate = require('./validate')

const CHUNK_DELIMITER = Buffer.from('\r\n')
const CHUNK_TERMINATOR = Buffer.from('0\r\n\r\n')

module.exports = class HTTPClientRequest extends HTTPOutgoingMessage {
  constructor(opts = {}, onresponse = null) {
    if (typeof opts === 'function') {
      onresponse = opts
      opts = {}
    }

    opts = opts ? { ...opts } : {}

    const agent = opts.agent === false ? new HTTPAgent() : opts.agent || HTTPAgent.global
    const method = opts.method || 'GET'
    const path = opts.path || '/'
    const defaultPort = opts.defaultPort || (agent && agent.defaultPort) || 80
    const host = (opts.host = opts.host || 'localhost')
    const port = (opts.port = opts.port || defaultPort)

    validate.validateMethod(method)
    validate.validatePath(path)

    const headers = normalize({ host: hostHeader(host, port, defaultPort), ...opts.headers })

    super()

    this._headers = headers
    this._method = method
    this._path = path

    // GET and HEAD requests carry no body unless one is written, in which case
    // it is framed like any other.
    this._expectsBody = method !== 'GET' && method !== 'HEAD'

    this._pendingWrite = null

    agent.addRequest(this, opts)

    if (onresponse) this.once('response', onresponse)
  }

  get method() {
    return this._method
  }

  get path() {
    return this._path
  }

  // For Node.js compatibility
  abort() {
    return this.destroy()
  }

  _isUpgrade() {
    return hasToken(this._headers.connection, 'upgrade')
  }

  _header() {
    validate.validateMethod(this._method)
    validate.validatePath(this._path)

    let h = `${this._method} ${this._path} HTTP/1.1\r\n`

    for (const name of Object.keys(this._headers)) {
      const n = name.toLowerCase()
      const v = this._headers[name]

      validate.validateHeaderName(n)
      validate.validateHeaderValue(n, v)

      h += `${httpCase(n)}: ${v}\r\n`
    }

    if (this._chunked) h += 'Transfer-Encoding: chunked\r\n'

    h += '\r\n'

    return h
  }

  _frame(length = -1) {
    // An upgrade request hands the connection over as it is, so whatever
    // follows the headers belongs to the new protocol and must not be framed.
    if (this._isUpgrade()) return

    super._frame(length)
  }

  _write(data, encoding, cb) {
    if (this._headersSent === false) {
      this._frame(bodyLength(this, data))

      this.flushHeaders()
    }

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
      if (this._expectsBody) this._frame(0)

      this.flushHeaders()
    }

    if (this._chunked) this._socket.write(CHUNK_TERMINATOR)

    cb(null)
  }

  _predestroy() {
    super._predestroy()

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

function hostHeader(host, port, defaultPort) {
  const i = host.indexOf(':')

  if (i !== -1 && host.includes(':', i + 1) && host.charCodeAt(0) !== 91 /* [ */) {
    host = `[${host}]`
  }

  if (port && +port !== defaultPort) {
    host += ':' + port
  }

  return host
}

function bodyLength(message, data) {
  if (isFinishing(message) === false) return -1

  return data.byteLength + message._writableState.buffered
}
