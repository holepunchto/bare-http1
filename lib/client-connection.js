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

    this._socket = socket

    this._req = null
    this._res = null

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

  _onerror(err) {
    if (this._req) this._req.destroy(err)
  }

  _onclose() {
    if (this._req) this._req.destroy()
  }

  _onend() {
    if (this._req) this._req.destroy(errors.CONNECTION_LOST())
  }

  _ondata(data) {
    this._idle = false

    try {
      for (const op of this._parser.push(data)) {
        switch (op.type) {
          case RESPONSE:
            this._req.on('close', () => {
              this._req = null
            })

            this._res = new this._IncomingMessage(this._socket, {
              headers: op.headers,
              statusCode: op.code,
              statusMessage: op.reason
            })

            this._res.on('close', () => {
              this._res = null
              this._idle = true

              this._socket.emit('free')
            })

            if (op.headers.connection && op.headers.connection.toLowerCase() === 'upgrade') {
              return this._onupgrade(this._parser.end())
            }

            this._req.emit('response', this._res)
            break

          case DATA:
            this._res.push(op.data)
            break

          case END:
            if (this._res) {
              this._res._socket = null
              this._res.push(null)
            }

            if (this._req) {
              this._req._socket = null
              this._req.destroy()
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

    const res = this._res
    const req = this._req

    res._upgrade = req._upgrade = true

    const upgraded = req.emit('upgrade', res, this._socket, data || EMPTY)

    res.push(null)
    req.destroy()

    if (!upgraded) this._socket.destroy()
  }

  _ontimeout() {
    if (this._req) this._req.emit('timeout')
  }

  _ondrain() {
    if (this._req) this._req._continueWrite()
  }

  _detach() {
    this._socket
      .off('error', this._onerror)
      .off('close', this._onclose)
      .off('end', this._onend)
      .off('data', this._ondata)
      .off('drain', this._ondrain)
      .off('timeout', this._ontimeout)

    HTTPClientConnection._connections.delete(this._socket)
  }
}
