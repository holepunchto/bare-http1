const { isEnding } = require('bare-stream')
const HTTPParser = require('bare-http-parser')
const HTTPIncomingMessage = require('./incoming-message')
const errors = require('./errors')
const { hasToken } = require('./headers')

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

    // Whether the peer has said that it is going to close the connection, in
    // which case the socket must not go back into the agent's pool.
    this._close = false

    // Whether an interim 1xx response is being parsed, whose end does not
    // complete the request.
    this._informational = false

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

  request(req) {
    this._req = req

    // A response to HEAD is framed as though it had a body but never carries
    // one, and only the request knows that.
    if (req.method === 'HEAD') this._parser.skipBody()
  }

  _complete() {
    if (this._res !== null) {
      this._res._socket = null
      this._res.push(null)
    }

    if (this._req !== null) {
      this._req._socket = null
      this._req.destroy()
    }
  }

  _fail(err) {
    const req = this._req
    const res = this._res

    this._req = null
    this._res = null

    // A response whose body has already arrived in full is left alone, as its
    // consumer may not have read all of it yet.
    if (res !== null && isEnding(res) === false) {
      res.emit('aborted')
      res.destroy(err || errors.CONNECTION_LOST())
    }

    if (req !== null) {
      if (err && res === null) req.destroy(err)
      else req.destroy()
    }
  }

  _onerror(err) {
    this._fail(err)
  }

  _onclose() {
    // No error is attached, as the close may well have been initiated locally.
    this._fail(null)
  }

  _onend() {
    let complete = false

    // A response whose body is framed by the connection closing is completed by
    // the close. Anything else still in flight has been cut short.
    try {
      for (const op of this._parser.end()) {
        if (op.type === END) complete = true
      }
    } catch {
      // Reported as a lost connection below.
    }

    if (complete) this._complete()
    else this._fail(errors.CONNECTION_LOST())
  }

  _ondata(data) {
    this._idle = false

    try {
      for (const op of this._parser.push(data)) {
        switch (op.type) {
          case RESPONSE: {
            const httpVersion = op.version === 'HTTP/1.0' ? '1.0' : '1.1'
            const upgrade = hasToken(op.headers.connection, 'upgrade')

            // An interim 1xx response is not the response to the request; the
            // real one still follows, so the request is left open. A 101
            // handshake is the exception, as it completes an upgrade.
            if (upgrade === false && op.code >= 100 && op.code < 200) {
              this._informational = true

              if (this._req) {
                this._req.emit('information', {
                  httpVersion,
                  statusCode: op.code,
                  statusMessage: op.reason,
                  headers: op.headers
                })
              }

              break
            }

            this._req.on('close', () => {
              this._req = null
            })

            this._res = new this._IncomingMessage(this._socket, {
              headers: op.headers,
              httpVersion,
              statusCode: op.code,
              statusMessage: op.reason
            })

            // HTTP/1.0 has no persistent connections unless the peer asks for
            // them, and any peer may bow out with `Connection: close`.
            this._close =
              hasToken(op.headers.connection, 'close') ||
              (httpVersion === '1.0' && hasToken(op.headers.connection, 'keep-alive') === false)

            this._res.on('close', () => {
              this._res = null
              this._idle = true

              if (this._close) this._socket.end()
              else this._socket.emit('free')
            })

            if (upgrade) return this._onupgrade(this._parser.drain())

            this._req.emit('response', this._res)
            break
          }

          case DATA:
            if (this._res) this._res.push(op.data)
            break

          case END:
            // The end of an interim response does not complete the request.
            if (this._informational) {
              this._informational = false
              break
            }

            this._complete()
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
