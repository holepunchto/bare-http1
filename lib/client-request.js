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

    this._response = null
    this._responseHeadComplete = false
    this._responseHeadBuffer = null
    this._responseBodyBuffer = null

    this._pendingFinal = null

    if (onresponse) this.once('response', onresponse)

    socket
      .on('close', this._onclose.bind(this))
      .on('data', this._ondata.bind(this))
      .on('end', this._onend.bind(this))
      .on('error', this._onerror.bind(this))
  }

  _header () {
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
    if (!this._responseHeadComplete) {
      const blankLine = Buffer.from([13, 10, 13, 10])
      const blankLineIndex = data.indexOf(blankLine)
      const hasBlankLine = blankLineIndex !== -1

      const h = hasBlankLine ? data.subarray(0, blankLineIndex) : data

      if (this._responseHeadBuffer !== null) {
        this._responseHeadBuffer = Buffer.concat([this._responseHeadBuffer, h])
      } else {
        this._responseHeadBuffer = h
      }

      if (hasBlankLine) {
        this._responseHeadComplete = true
        this._readHead(this._responseHeadBuffer)
        data = data.subarray(blankLineIndex + blankLine.byteLength)
      }
    }

    if (this._responseHeadComplete) this._readBody(data)
  }

  _readHead (head) {
    const h = head.toString().split('\r\n')

    let [, statusCode, statusMessage] = h[0].split(' ')
    if (!statusCode || !statusMessage) return this._socket.destroy()

    statusCode = +statusCode

    const headers = {}

    for (let i = 1; i < h.length; i++) {
      const [name, value] = h[i].split(': ')
      headers[name.toLowerCase()] = value
    }

    this._response = new HTTPIncomingMessage(this._socket, headers, { statusCode, statusMessage })

    this.emit('response', this._response)
  }

  _readBody (data) {
    const len = Number(this._response.getHeader('content-length')) || 0
    const chunked = this._response.getHeader('transfer-encoding') === 'chunked'
    const chunkedTail = Buffer.from([48, 13, 10, 13, 10]) // '0\r\n\r\n'

    if (this._responseBodyBuffer !== null) {
      this._responseBodyBuffer = Buffer.concat([this._responseBodyBuffer, data])
    } else {
      this._responseBodyBuffer = data
    }

    const hasChunkedTail = chunked && this._responseBodyBuffer.indexOf(chunkedTail) !== -1
    if (hasChunkedTail) {
      const slices = []
      let sliceStart = -1
      let readingSlice = false

      for (let i = 0; i < this._responseBodyBuffer.byteLength - 5; i++) {
        if (readingSlice && sliceStart === -1) {
          sliceStart = i
        } else if (this._responseBodyBuffer[i] === 10 && this._responseBodyBuffer[i - 1] === 13) {
          if (readingSlice && sliceStart !== -1) {
            slices.push([sliceStart, i - 1])
            sliceStart = -1
          }

          readingSlice = !readingSlice
        }
      }

      const messageSlices = slices.map(([s, e]) => this._responseBodyBuffer.subarray(s, e))
      this._responseBodyBuffer = Buffer.concat(messageSlices)
    }

    if ((!chunked && this._responseBodyBuffer.byteLength === len) || hasChunkedTail) {
      if (this._responseBodyBuffer.byteLength > 0) this._response.push(this._responseBodyBuffer)
      this._response.push(null)
      this._socket.destroy()
    }
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
    if (!this._responseHeadComplete) this.emit('error', errors.CONNECTION_LOST())
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
