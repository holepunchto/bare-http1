const HTTPIncomingMessage = require('./incoming-message')
const constants = require('./constants')
const errors = require('./errors')

module.exports = class HTTPClientConnection {
  constructor (socket, opts = {}) {
    const {
      IncomingMessage = HTTPIncomingMessage
    } = opts

    this.socket = socket

    this.req = null
    this.res = null

    this._IncomingMessage = IncomingMessage

    this._state = constants.state.BEFORE_HEAD
    this._length = -1
    this._read = 0
    this._buffer = null

    socket
      .on('error', this._onerror.bind(this))
      .on('close', this._onclose.bind(this))
      .on('end', this._onend.bind(this))
      .on('data', this._ondata.bind(this))
      .on('drain', this._ondrain.bind(this))
  }

  _onerror (err) {
    if (this.req) this.req.destroy(err)
  }

  _onclose () {
    if (this.req) this.req._continueFinal()
  }

  _onend () {
    if (this.req) this.req.destroy(errors.CONNECTION_LOST())
  }

  _ondata (data) {
    if (this._state === constants.state.IN_BODY) return this._onbody(data)

    if (this._buffer !== null) {
      this._buffer = Buffer.concat([this._buffer, data])
    } else {
      this._buffer = data
    }

    let hits = 0

    for (let i = 0; i < this._buffer.byteLength; i++) {
      const b = this._buffer[i]

      if (hits === 0 && b === 13) {
        hits++
      } else if (hits === 1 && b === 10) {
        hits++

        if (this._state === constants.state.BEFORE_CHUNK) {
          const head = this._buffer.subarray(0, i - 1)
          this._buffer = i + 1 === this._buffer.byteLength ? null : this._buffer.subarray(i + 1)
          i = 0
          hits = 0
          this._onchunklength(head)

          if (this._buffer === null) break
        } else if (this._state === constants.state.IN_CHUNK) {
          const chunk = this._buffer.subarray(0, i - 1)

          if (chunk.byteLength !== this._length) {
            hits = 0
            continue
          }

          this._buffer = i + 1 === this._buffer.byteLength ? null : this._buffer.subarray(i + 1)
          i = 0
          hits = 0
          this._onchunk(chunk)

          if (this._buffer === null) break
        }
      } else if (hits === 2 && b === 13) {
        hits++
      } else if (hits === 3 && b === 10) {
        if (this._state === constants.state.BEFORE_HEAD) {
          const head = this._buffer.subarray(0, i - 3)
          this._buffer = i + 1 === this._buffer.byteLength ? null : this._buffer.subarray(i + 1)
          i = 0
          hits = 0
          this._onhead(head)

          if (this._buffer === null) break
        }
      } else {
        hits = 0
      }
    }
  }

  _onhead (data) {
    this._state = constants.state.IN_HEAD

    const r = data.toString().split('\r\n')
    if (r.length === 0) return this.socket.destroy()

    const [, statusCode, statusMessage] = r[0].split(' ')
    if (!statusCode || !statusMessage) return this.socket.destroy()

    const headers = {}

    for (let i = 1; i < r.length; i++) {
      const [name, value] = r[i].split(': ')
      headers[name.toLowerCase()] = value
    }

    this.res = new this._IncomingMessage(this.socket, headers, { statusCode: parseInt(statusCode, 10), statusMessage })

    this.req.on('close', () => { this.req = null })
    this.res.on('close', () => { this.res = null; this._onreset() })

    this.req.emit('response', this.res)

    if (headers['transfer-encoding'] === 'chunked') {
      this._state = constants.state.BEFORE_CHUNK
    } else {
      this._length = parseInt(headers['content-length'], 10) || 0

      if (this._length === 0) return this._onfinished()

      this._state = constants.state.IN_BODY

      if (this._buffer) {
        const body = this._buffer
        this._buffer = null
        this._onbody(body)
      }
    }
  }

  _onchunklength (data) {
    this._length = parseInt(data.toString(), 16)

    if (this._length === 0) this._onfinished()
    else this._state = constants.state.IN_CHUNK
  }

  _onchunk (data) {
    this._read += data.byteLength

    this.res.push(data)

    this._state = constants.state.BEFORE_CHUNK
  }

  _onbody (data) {
    this._read += data.byteLength

    this.res.push(data)

    if (this._read === this._length) this._onfinished()
  }

  _onfinished () {
    if (this.res) this.res.push(null)
    if (this.req) this.req._continueFinal()

    this.socket.end()
  }

  _onreset () {
    this._state = constants.state.BEFORE_HEAD
    this._length = -1
    this._read = 0
    this._buffer = null
  }

  _ondrain () {
    if (this.res) this.res._continueWrite()
  }
}
