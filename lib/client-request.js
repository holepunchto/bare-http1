const tcp = require('bare-tcp')
const HTTPOutgoingMessage = require('./outgoing-message')
const HTTPClientConnection = require('./client-connection')

module.exports = class HTTPClientRequest extends HTTPOutgoingMessage {
  constructor (opts = {}, onresponse = null) {
    if (typeof opts === 'function') {
      onresponse = opts
      opts = {}
    }

    const {
      connection = new HTTPClientConnection(tcp.createConnection(opts))
    } = opts

    super(connection.socket)

    connection.req = this

    this.method = opts.method || 'GET'
    this.path = opts.path || '/'
    const host = opts.host || 'localhost'
    const port = opts.port || 80

    this.headers = { host: host + ':' + port, ...opts.headers }

    this._connection = connection
    this._chunked = true

    this._pendingFinal = null

    if (onresponse) this.once('response', onresponse)
  }

  _header () {
    let h = `${this.method} ${this.path} HTTP/1.1\r\n`

    for (const name of Object.keys(this.headers)) {
      const n = name.toLowerCase()
      const v = this.headers[name]

      if (n === 'content-length') this._chunked = false

      h += `${httpCase(n)}: ${v}\r\n`
    }

    if (this._chunked) h += 'Transfer-Encoding: chunked\r\n'

    h += '\r\n'

    return h
  }

  _write (data, cb) {
    if (this.headersSent === false) this.flushHeaders()

    if (this._chunked) {
      data = Buffer.concat([
        Buffer.from('' + data.byteLength.toString(16) + '\r\n'),
        data,
        Buffer.from('\r\n')
      ])
    }

    if (this.socket.write(data)) cb(null)
    else this._pendingWrite = cb
  }

  _final (cb) {
    if (this.headersSent === false) this.flushHeaders()

    if (this._chunked) this.socket.write(Buffer.from('0\r\n\r\n'))

    this._pendingFinal = cb
  }

  _continueWrite () {
    if (this._pendingWrite === null) return
    const cb = this._pendingWrite
    this._pendingWrite = null
    cb(null)
  }

  _continueFinal () {
    if (this._pendingFinal === null) return
    const cb = this._pendingFinal
    this._pendingFinal = null
    cb(null)
  }
}

function httpCase (n) {
  let s = ''
  for (const part of n.split('-')) {
    s += (s ? '-' : '') + part.slice(0, 1).toUpperCase() + part.slice(1)
  }
  return s
}
