const HTTPAgent = require('./agent')
const HTTPOutgoingMessage = require('./outgoing-message')

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
    const headers = { host: hostHeader(host, port, defaultPort), ...opts.headers }

    super()

    agent.addRequest(this, opts)

    this._headers = headers
    this._method = method
    this._path = path

    this._chunked = method !== 'GET' && method !== 'HEAD'

    this._pendingWrite = null
    this._pendingFinal = null

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

  _header() {
    let h = `${this._method} ${this._path} HTTP/1.1\r\n`

    let upgrade = false

    for (const name of Object.keys(this._headers)) {
      const n = name.toLowerCase()
      const v = this._headers[name]

      if (n === 'content-length') this._chunked = false
      if (n === 'connection' && v && v.toLowerCase() === 'upgrade') upgrade = true

      h += `${httpCase(n)}: ${v}\r\n`
    }

    if (upgrade) this._chunked = false

    if (this._chunked) h += 'Transfer-Encoding: chunked\r\n'

    h += '\r\n'

    return h
  }

  _write(data, encoding, cb) {
    if (this._headersSent === false) this.flushHeaders()

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
    if (this._headersSent === false) this.flushHeaders()

    if (this._chunked) this._socket.write(CHUNK_TERMINATOR)

    this._pendingFinal = cb
  }

  _predestroy() {
    super._predestroy()

    this._continueWrite()
    this._continueFinal()
  }

  _continueWrite() {
    if (this._pendingWrite === null) return
    const cb = this._pendingWrite
    this._pendingWrite = null
    cb(null)
  }

  _continueFinal() {
    if (this._pendingFinal === null) return
    const cb = this._pendingFinal
    this._pendingFinal = null
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
