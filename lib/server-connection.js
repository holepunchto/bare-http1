const HTTPIncomingMessage = require('./incoming-message')
const HTTPServerResponse = require('./server-response')

module.exports = class HTTPServerConnection {
  constructor (server, socket, opts = {}) {
    const {
      IncomingMessage = HTTPIncomingMessage,
      ServerResponse = HTTPServerResponse
    } = opts

    this._server = server
    this._socket = socket

    this._IncomingMessage = IncomingMessage
    this._ServerResponse = ServerResponse

    this._requests = new Set()
    this._responses = new Set()

    this._buffer = null

    socket
      .on('error', this._onerror.bind(this))
      .on('data', this._ondata.bind(this))
      .on('drain', this._ondrain.bind(this))
  }

  _onerror (err) {
    this._socket.destroy(err)
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
        hits = 0

        const head = this._buffer.subarray(0, i + 1)
        this._buffer = i + 1 === this._buffer.byteLength ? null : this._buffer.subarray(i + 1)
        this._onrequest(head)

        if (this._buffer === null) break
      } else {
        hits = 0
      }
    }
  }

  _onrequest (head) {
    const r = head.toString().trim().split('\r\n')
    if (r.length === 0) return this._socket.destroy()

    const [method, url] = r[0].split(' ')
    if (!method || !url) return this._socket.destroy()

    const headers = {}

    for (let i = 1; i < r.length; i++) {
      const [name, value] = r[i].split(': ')
      headers[name.toLowerCase()] = value
    }

    const req = new this._IncomingMessage(this._socket, headers, { method, url })
    const res = new this._ServerResponse(this._socket, req, headers.connection === 'close')

    this._requests.add(req)
    this._responses.add(res)

    req.push(null)

    req.on('close', () => this._requests.delete(req))
    res.on('close', () => this._responses.delete(res))

    this._server.emit('request', req, res)
  }

  _ondrain () {
    for (const res of this._responses) res._continueWrite()
  }
}
