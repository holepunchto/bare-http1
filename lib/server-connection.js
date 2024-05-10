const HTTPIncomingMessage = require('./incoming-message')
const HTTPServerResponse = require('./server-response')
const constants = require('./constants')

module.exports = class HTTPServerConnection {
  constructor (server, socket, opts = {}) {
    const {
      IncomingMessage = HTTPIncomingMessage,
      ServerResponse = HTTPServerResponse
    } = opts

    this.server = server
    this.socket = socket

    this.req = null
    this.res = null

    this._IncomingMessage = IncomingMessage
    this._ServerResponse = ServerResponse

    this._state = constants.state.BEFORE_HEAD
    this._length = -1
    this._read = 0
    this._buffer = null

    socket
      .on('error', this._onerror.bind(this))
      .on('data', this._ondata.bind(this))
      .on('drain', this._ondrain.bind(this))
  }

  _onerror (err) {
    this.socket.destroy(err)
  }

  _ondata (data) {
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

    const [method, url] = r[0].split(' ')
    if (!method || !url) return this.socket.destroy()

    const headers = {}

    for (let i = 1; i < r.length; i++) {
      const [name, value] = r[i].split(': ')
      headers[name.toLowerCase()] = value
    }

    this.req = new this._IncomingMessage(this.socket, headers, { method, url })
    this.res = new this._ServerResponse(this.socket, this.req, headers.connection === 'close')

    this.req.on('close', () => { this.req = null })
    this.res.on('close', () => { this.res = null; this._onreset() })

    this.req.push(null)

    this.server.emit('request', this.req, this.res)
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
