const HTTPParser = require('bare-http-parser')
const HTTPIncomingMessage = require('./incoming-message')
const errors = require('./errors')

const {
  constants: { RESPONSE, DATA, END }
} = HTTPParser

const EMPTY = Buffer.alloc(0)

module.exports = class HTTPClientConnection {
  static _connections = new WeakMap()

  static for(socket) {
    return this._connections.get(socket) || null
  }

  static from(socket, opts) {
    return this.for(socket) || new this(socket, opts)
  }

  constructor(socket, opts = {}) {
    const { IncomingMessage = HTTPIncomingMessage } = opts

    this.socket = socket

    this.req = null
    this.res = null

    this._IncomingMessage = IncomingMessage

    this._parser = new HTTPParser()
    this._idle = true

    this._onerror = this._onerror.bind(this)
    this._onclose = this._onclose.bind(this)
    this._onend = this._onend.bind(this)
    this._ondata = this._ondata.bind(this)
    this._ondrain = this._ondrain.bind(this)
    this._ontimeout = this._ontimeout.bind(this)

    socket
      .on('error', this._onerror)
      .on('close', this._onclose)
      .on('end', this._onend)
      .on('data', this._ondata)
      .on('drain', this._ondrain)
      .on('timeout', this._ontimeout)

    HTTPClientConnection._connections.set(socket, this)
  }

  get idle() {
    return this._idle
  }

  _onerror(err) {
    if (this.req) this.req.destroy(err)
  }

  _onclose() {
    if (this.req) this.req._continueFinal()
  }

  _onend() {
    if (this.req) this.req.destroy(errors.CONNECTION_LOST())
  }

  _ondata(data) {
    this._idle = false

    try {
      for (const op of this._parser.push(data)) {
        switch (op.type) {
          case RESPONSE:
            this.req.on('close', () => {
              this.req = null
            })

            this.res = new this._IncomingMessage(this.socket, op.headers, {
              statusCode: op.code,
              statusMessage: op.reason
            })

            this.res.on('close', () => {
              this.res = null

              this._idle = true

              this.socket.emit('free')
            })

            if (
              op.headers.connection &&
              op.headers.connection.toLowerCase() === 'upgrade'
            ) {
              return this._onupgrade(this._parser.end())
            }

            this.req.emit('response', this.res)
            break

          case DATA:
            this.res.push(op.data)
            break

          case END:
            if (this.res) this.res.push(null)
            if (this.req) this.req._continueFinal()
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

    if (req.emit('upgrade', this.res, this.socket, data || EMPTY)) return

    this.socket.destroy()
  }

  _ontimeout() {
    if (this.req) this.req.emit('timeout')
  }

  _ondrain() {
    if (this.req) this.req._continueWrite()
  }

  _ondetach() {
    this.socket
      .off('error', this._onerror)
      .off('close', this._onclose)
      .off('end', this._onend)
      .off('data', this._ondata)
      .off('drain', this._ondrain)
      .off('timeout', this._ontimeout)

    HTTPClientConnection._connections.delete(this.socket)
  }
}
