const { createConnection } = require('bare-tcp')
const HTTPOutgoingMessage = require('./outgoing-message')
const HTTPIncomingMessage = require('./incoming-message')

module.exports = class HTTPClientRequest extends HTTPOutgoingMessage {
  constructor (opts = {}, onresponse = null) {
    const socket = createConnection(opts)

    super(socket)

    if (typeof opts === 'function') {
      onresponse = opts
      opts = {}
    }

    this.method = opts.method || 'GET'
    this.path = opts.path || '/'

    const host = opts.host || 'localhost'
    const port = opts.port || 80
    this.headers = { host: host + ':' + port }

    this._socket = socket
    this._buffer = null
    this._cb = onresponse

    socket
      .on('error', this._onerror.bind(this))
      .on('data', this._ondata.bind(this))
  }

  _arrangeHeader () {
    let h = `${this.method} ${this.path} HTTP/1.1\r\n`

    for (const name of Object.keys(this.headers)) {
      const n = name.toLowerCase()
      const v = this.headers[name]

      h += `${httpCase(n)}: ${v}\r\n`
    }

    h += '\r\n'

    return h
  }

  _onerror (err) {
    this._socket.destroy(err)
  }

  _ondata (data) {
    const r = data.toString().trim().split('\r\n')
    if (r.length === 0) return this._socket.destroy()

    const [, statusCode, statusMessage] = r[0].split(' ')
    if (!statusCode || !statusMessage) return this._socket.destroy()

    const headers = {}
    let messageBody = null

    for (let i = 1; i < r.length; i++) {
      const [name, value] = r[i].split(': ')

      if (name === '') { // empty line
        const nextLine = r[i + 1]
        if (nextLine) messageBody = nextLine

        break
      }

      headers[name.toLowerCase()] = value
    }

    const res = new HTTPIncomingMessage(this._socket, headers, { statusCode, statusMessage })

    if (messageBody) res.push(messageBody)
    res.push(null)

    if (this._cb) this._cb(res)

    this._socket.destroy()
  }

  _final (cb) {
    if (this.headersSent === false) this.flushHeaders()

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
