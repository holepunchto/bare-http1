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

    this._pendingFinal = null

    if (onresponse) this.on('response', onresponse)

    socket
      .on('data', this._ondata.bind(this))
      .on('error', this._onerror.bind(this))
      .on('close', this._onclose.bind(this))
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

  _final (cb) {
    if (this.headersSent === false) this.flushHeaders()

    this._pendingFinal = cb
  }

  _ondata (data) {
    const blankLine = Buffer.from([13, 10, 13, 10])
    const i = data.indexOf(blankLine)

    if (i === -1) return this._socket.destroy()

    const head = data.subarray(0, i)
    const messageBody = data.subarray(i + blankLine.byteLength)

    this._onresponse(head, messageBody)
  }

  _onresponse (head, body) {
    const h = head.toString().split('\r\n')

    let [, statusCode, statusMessage] = h[0].split(' ')
    if (!statusCode || !statusMessage) return this._socket.destroy()

    statusCode = +statusCode

    const headers = {}

    for (let i = 1; i < h.length; i++) {
      const [name, value] = h[i].split(': ')
      headers[name.toLowerCase()] = value
    }

    const res = new HTTPIncomingMessage(this._socket, headers, { statusCode, statusMessage })

    this.emit('response', res)

    if (body.byteLength > 0) res.push(body)
    res.push(null)

    this._socket.destroy()
  }

  _onerror (err) {
    this._socket.destroy(err)
  }

  _onclose () {
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