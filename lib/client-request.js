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
    this._pendingFinal = null

    this._response = null

    this._responseHeadComplete = false
    this._responseHeadBuffer = null
    this._responseMessageLength = -1
    this._responseMessageLengthRead = 0
    this._isResponseMessageChunked = false
    this._chunkedMessageChunkedBuffer = null

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

    this._isResponseMessageChunked = this._response.getHeader('transfer-encoding') === 'chunked'
    if (!this._isResponseMessageChunked) {
      this._responseMessageLength = Number(this._response.getHeader('content-length')) || 0
    }

    this.emit('response', this._response)
  }

  _readBody (data) {
    if (!this._isResponseMessageChunked && data.byteLength > 0) {
      this._responseMessageLengthRead += data.byteLength
      this._response.push(data)
    }

    let ended = false

    if (this._isResponseMessageChunked) {
      let lengthStart = 0
      let messageStart = -1

      let hits = 0

      if (this._chunkedMessageChunkedBuffer !== null) {
        data = Buffer.concat([this._chunkedMessageChunkedBuffer, data])
      }

      this._chunkedMessageChunkedBuffer = null

      const readingEnum = Object.freeze({ LENGTH: 'length', MESSAGE: 'message' })
      let reading = readingEnum.LENGTH

      for (let i = 0; i < data.byteLength; i++) {
        const b = data[i]

        if (hits === 0 && b === 13) {
          hits++
        } else if (hits === 1 && b === 10) {
          if (reading === readingEnum.LENGTH) {
            const nextChunklength = data.subarray(lengthStart, i - 1)

            if (Buffer.compare(nextChunklength, Buffer.from([48])) === 0) {
              ended = true
              break
            }

            messageStart = i + 1
            reading = readingEnum.MESSAGE
          } else {
            const newChunk = data.subarray(messageStart, i - 1)
            this._response.push(newChunk)

            lengthStart = i + 1
            reading = readingEnum.LENGTH
          }

          hits = 0
        } else if (i === data.byteLength - 1) {
          this._chunkedMessageChunkedBuffer = data.subarray(lengthStart)
        }
      }
    }

    if (!this._isResponseMessageChunked) {
      ended = this._responseMessageLength === this._responseMessageLengthRead
    }

    if (ended) {
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
