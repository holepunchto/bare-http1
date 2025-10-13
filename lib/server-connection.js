const tcp = require('bare-tcp')
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

    if (this.server.timeout) socket.setTimeout(this.server.timeout)
  }

  get idle() {
    return this._idle
  }

  _onclose() {
    if (this.req && !isEnded(this.req)) this.req.destroy()
    if (this.res && !isFinished(this.res)) this.res.destroy()
    const err = getStreamError(this.socket)
    if (err) this.socket.destroy(err)
  }

  _ondata(data) {
    this._idle = false

    try {
      for (const op of this._parser.push(data)) {
        switch (op.type) {
          case REQUEST:
            this.req = new this._IncomingMessage(this.socket, op.headers, {
              method: op.method,
              url: op.url
            })

            this.req.on('close', () => {
              this.req = null

              this._idle = true

              if (this.server._state & tcp.constants.state.CLOSING) {
                this.socket.destroy()
              }
            })

            // Eagerly open the request stream
            this.req.resume()
            this.req.pause()

            if (
              op.headers.connection &&
              op.headers.connection.toLowerCase() === 'upgrade'
            ) {
              return this._onupgrade(this._parser.end())
            }

            this.res = new this._ServerResponse(
              this.socket,
              this.req,
              op.headers.connection === 'close'
            )

            this.res.on('close', () => {
              this.res = null
            })

            this.server.emit('request', this.req, this.res)
            break

          case DATA:
            this.req.push(op.data)
            break

          case END:
            if (this.req) this.req.push(null)
            break
        }
      }
    } catch (err) {
      this.socket.destroy(err)
    }
  }

  _onupgrade(data) {
    this._ondetach()

    const req = this.req

    req.upgrade = true
    req.destroy()

    this.server.emit('upgrade', req, this.socket, data || EMPTY)
  }

  _ontimeout() {
    const reqTimeout = this.req && this.req.emit('timeout')
    const resTimeout = this.res && this.res.emit('timeout')
    const serverTimeout = this.server.emit('timeout', this.socket)

    if (!reqTimeout && !resTimeout && !serverTimeout) this.socket.destroy()
  }

  _ondrain() {
    if (this.res) this.res._continueWrite()
  }

  _ondetach() {
    this.socket
      .off('error', noop)
      .off('close', this._onclose)
      .off('data', this._ondata)
      .off('drain', this._ondrain)
      .off('timeout', this._ontimeout)

    HTTPServerConnection._connections.delete(this.socket)
  }
}

function noop() {}
