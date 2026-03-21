const { isEnded, isFinished, getStreamError } = require('bare-stream')
const HTTPParser = require('bare-http-parser')
const HTTPIncomingMessage = require('./incoming-message')
const HTTPServerResponse = require('./server-response')

const {
  constants: { REQUEST, DATA, END }
} = HTTPParser

const EMPTY = Buffer.alloc(0)

module.exports = class HTTPServerConnection {
  static _connections = new WeakMap()

  static for(socket) {
    return this._connections.get(socket) || null
  }

  constructor(server, socket, opts = {}) {
    const { IncomingMessage = HTTPIncomingMessage, ServerResponse = HTTPServerResponse } = opts

    this._server = server
    this._socket = socket

    this._req = null
    this._res = null

    this._IncomingMessage = IncomingMessage
    this._ServerResponse = ServerResponse

    this._parser = new HTTPParser()
    this._idle = true

    this._onclose = this._onclose.bind(this)
    this._ondata = this._ondata.bind(this)
    this._ondrain = this._ondrain.bind(this)
    this._ontimeout = this._ontimeout.bind(this)

    socket
      .on('error', noop)
      .on('close', this._onclose)
      .on('data', this._ondata)
      .on('drain', this._ondrain)
      .on('timeout', this._ontimeout)

    HTTPServerConnection._connections.set(socket, this)

    if (this._server.timeout) socket.setTimeout(this._server.timeout)
  }

  get server() {
    return this._server
  }

  get socket() {
    return this._socket
  }

  get req() {
    return this._req
  }

  get res() {
    return this._res
  }

  get idle() {
    return this._idle
  }

  _onclose() {
    if (this._req && !isEnded(this._req)) this._req.destroy()
    if (this._res && !isFinished(this._res)) this._res.destroy()

    const err = getStreamError(this._socket)
    if (err) this._socket.destroy(err)
  }

  _ondata(data) {
    this._idle = false

    try {
      for (const op of this._parser.push(data)) {
        switch (op.type) {
          case REQUEST:
            this._req = new this._IncomingMessage(this._socket, {
              headers: op.headers,
              method: op.method,
              url: op.url
            })

            this._req.on('close', () => {
              this._req = null

              this._idle = true

              if (this._server.closing) this._socket.destroy()
            })

            // Eagerly open the request stream
            this._req.resume()
            this._req.pause()

            if (op.headers.connection && op.headers.connection.toLowerCase() === 'upgrade') {
              return this._onupgrade(this._parser.end())
            }

            this._res = new this._ServerResponse(this._socket, this._req)

            this._res.on('close', () => {
              this._res = null
            })

            this._server.emit('request', this._req, this._res)
            break

          case DATA:
            this._req.push(op.data)
            break

          case END:
            if (this._req) {
              this._req._socket = null
              this._req.push(null)
            }
            break
        }
      }
    } catch (err) {
      this._socket.destroy(err)
    }
  }

  _onupgrade(data) {
    this._detach()

    const req = this._req

    req._upgrade = true

    const upgraded = this._server.emit('upgrade', req, this._socket, data || EMPTY)

    req.push(null)

    if (!upgraded) this._socket.destroy()
  }

  _ontimeout() {
    const reqTimeout = this._req && this._req.emit('timeout')
    const resTimeout = this._res && this._res.emit('timeout')
    const serverTimeout = this._server.emit('timeout', this._socket)

    if (!reqTimeout && !resTimeout && !serverTimeout) this._socket.destroy()
  }

  _ondrain() {
    if (this._res) this._res._continueWrite()
  }

  _detach() {
    this._socket
      .off('error', noop)
      .off('close', this._onclose)
      .off('data', this._ondata)
      .off('drain', this._ondrain)
      .off('timeout', this._ontimeout)

    HTTPServerConnection._connections.delete(this._socket)
  }
}

function noop() {}
