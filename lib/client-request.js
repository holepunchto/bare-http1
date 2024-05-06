const { createConnection } = require('bare-tcp')
const HTTPOutgoingMessage = require('./outgoing-message')
const HTTPIncomingMessage = require('./incoming-message')
const errors = require('./errors')

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
    this._replied = false

    this._pendingFinal = null

    if (onresponse) this.once('response', onresponse)

    socket
      .on('close', this._onclose.bind(this))
      .on('data', this._ondata.bind(this))
      .on('end', this._onend.bind(this))
      .on('error', this._onerror.bind(this))
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
    this._replied = true

    const h = head.toString().split('\r\n')

    let [, statusCode, statusMessage] = h[0].split(' ')
    if (!statusCode || !statusMessage) return this._socket.destroy()

    statusCode = +statusCode

    const headers = {}

    for (let i = 1; i < h.length; i++) {
      const [name, value] = h[i].split(': ')
      headers[name.toLowerCase()] = value
    }

    const isChunked = headers['Transfer-Encoding'] === 'chunked' || headers['transfer-encoding'] === 'chunked'

    const res = new HTTPIncomingMessage(this._socket, headers, { statusCode, statusMessage })

    this.emit('response', res)

    if (body.byteLength > 0) {
      if (isChunked) {
        let message = Buffer.from([])

        let readingMessage = false
        let hits = 0

        for (let i = 0; i < body.byteLength; i++) {
          const b = body[i]

          if (readingMessage && hits === 0 && b !== 13) {
            message = Buffer.concat([message, Buffer.from([b])])
          } else if (hits === 0 && b === 13) {
            hits++
          } else if (hits === 1 && b === 10) {
            hits = 0
            readingMessage = !readingMessage
          }
        }

        res.push(message)
      } else {
        res.push(body)
      }
    }

    res.push(null)

    this._socket.destroy()
  }

  _onerror (err) {
    this._socket.destroy(err)
  }

  _onend () {
    this.emit('error', errors.CONNECTION_LOST())
    this._socket.destroy()
  }

  _onclose () {
    if (this._pendingFinal === null) return
    const cb = this._pendingFinal
    this._pendingFinal = null
    cb(null)
  }

  _destroy (cb) {
    if (!this._replied) this.emit('error', errors.CONNECTION_LOST())
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
