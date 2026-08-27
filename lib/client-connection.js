const { isEnding, isFinished } = require('bare-stream')
const HTTPParser = require('bare-http-parser')
const HTTPIncomingMessage = require('./incoming-message')
const errors = require('./errors')
const { has, hasToken } = require('./headers')

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
    const { IncomingMessage = HTTPIncomingMessage, maxHeaderSize, maxHeadersCount } = opts

    this._socket = socket

    this._req = null
    this._res = null

    this._IncomingMessage = IncomingMessage

    this._parser = new HTTPParser({ maxHeaderSize, maxHeadersCount })
    this._idle = true

    // Whether the peer has said that it is going to close the connection, in
    // which case the socket must not go back into the agent's pool.
    this._close = false

    // Whether an interim 1xx response is being parsed, whose end does not
    // complete the request.
    this._informational = false

    // Data that has not been handed to the parser yet, and the operations that
    // the parser is currently yielding.
    this._pending = []
    this._ops = null

    this._paused = false
    this._ended = false
    this._detached = false

    // Whether the body is arriving faster than it is being read, in which case
    // the socket is left paused until the consumer asks for more.
    this._backpressure = false

    this._onerror = this._onerror.bind(this)
    this._onclose = this._onclose.bind(this)
    this._onend = this._onend.bind(this)
    this._ondata = this._ondata.bind(this)
    this._ondrain = this._ondrain.bind(this)
    this._ontimeout = this._ontimeout.bind(this)
    this._ondemand = this._ondemand.bind(this)

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
    if (this._req !== null && isFinished(this._req) === false) this._close = true

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

    this._pending = []
    this._ops = null

    // A response whose body has already arrived in full is left alone, as its
    // consumer may not have read all of it yet.
    if (res !== null && isEnding(res) === false) {
      res.emit('aborted')
      res.destroy(err || errors.CONNECTION_LOST())
    }

    if (req !== null) {
      if (res === null) req.destroy(err || errors.CONNECTION_LOST())
      else req.destroy()
    }
  }

  _continue() {
    while (this._detached === false) {
      if (this._ops === null) {
        if (this._pending.length === 0) break

        this._ops = this._parser.push(this._pending.shift())
      }

      let op

      try {
        const next = this._ops.next()

        if (next.done) {
          this._ops = null
          continue
        }

        op = next.value
      } catch (err) {
        this._ops = null

        return this._socket.destroy(err)
      }

      try {
        this._onop(op)
      } catch (err) {
        return this._socket.destroy(err)
      }

      if (this._backpressure) return this._pause()
    }

    if (this._detached) return

    this._resume()

    if (this._ended) this._oninputend()
  }

  _onerror(err) {
    this._fail(err)
  }

  _onclose() {
    // Input that was held back while the body was not being read still frames
    // the response, so it is finished off before the close is reported and the
    // rest of the body is thrown away.
    if (this._ended) {
      this._backpressure = false

      this._continue()
    }

    // No error is attached, as the close may well have been initiated locally.
    this._fail(null)
  }

  _onend() {
    this._ended = true

    this._continue()
  }

  _ondata(data) {
    this._idle = false

    this._pending.push(data)

    this._continue()
  }

  _ondemand() {
    if (this._backpressure === false) return

    this._backpressure = false

    this._continue()
  }

  _oninputend() {
    this._ended = false

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

  _onop(op) {
    switch (op.type) {
      case RESPONSE: {
        const httpVersion = op.version === 'HTTP/1.0' ? '1.0' : '1.1'

        // An upgrade needs both the `Upgrade` header naming the protocol and a
        // `Connection` header listing it, as Node.js requires. Going on the
        // latter alone would let a peer turn an ordinary response into a socket
        // handover that the consumer never asked for.
        const upgrade = has(op.headers, 'upgrade') && hasToken(op.headers.connection, 'upgrade')

        // Nothing asked for this one. A peer that answers of its own accord, or
        // answers the same request twice, is trying to get a response of its
        // choosing paired up with whatever request comes next on the connection.
        if (this._req === null || this._res !== null) throw errors.UNEXPECTED_RESPONSE()

        // A 2xx to CONNECT means the tunnel is open, so everything past the
        // headers belongs to it rather than to HTTP.
        const tunnel = this._req.method === 'CONNECT' && op.code >= 200 && op.code < 300

        // A 101 that names no protocol has nothing to hand the connection over
        // to, so it is delivered as the response it claims to be, as Node.js
        // delivers it.
        const switching = op.code === 101 && upgrade === false

        // An interim 1xx response is not the response to the request; the real
        // one still follows, so the request is left open.
        if (upgrade === false && op.code >= 100 && op.code < 200 && op.code !== 101) {
          this._informational = true

          // The parser spends `skipBody` on the first set of headers it
          // completes, and an interim response is not the one the request was
          // waiting for.
          if (this._req.method === 'HEAD') this._parser.skipBody()

          this._req.emit('information', {
            httpVersion,
            statusCode: op.code,
            statusMessage: op.reason,
            headers: op.headers
          })

          break
        }

        const req = this._req

        req.on('close', () => {
          // Only the request the connection is currently on has any say in
          // this. A connection that goes back into the pool may already have
          // been handed the next request by the time this one closes.
          if (this._req !== req) return

          this._req = null
        })

        const res = new this._IncomingMessage(this._socket, {
          headers: op.headers,
          httpVersion,
          statusCode: op.code,
          statusMessage: op.reason
        })

        res._ondemand = this._ondemand

        this._res = res

        // HTTP/1.0 has no persistent connections unless the peer asks for
        // them, and any peer may bow out with `Connection: close`. The parser
        // stops for good at a 101, so a connection that carried one cannot
        // carry another exchange and must not be offered for one.
        this._close =
          switching ||
          hasToken(op.headers.connection, 'close') ||
          (httpVersion === '1.0' && hasToken(op.headers.connection, 'keep-alive') === false)

        // Registered only once the connection is known to still be carrying
        // HTTP. A socket that is handed over to another protocol is no longer
        // ours to hand back to the agent.
        if (upgrade || tunnel) {
          return this._onhandover(this._parser.drain(), tunnel ? 'connect' : 'upgrade')
        }

        res.on('close', () => {
          // Only the response the connection is currently on has any say in what
          // becomes of the socket.
          if (this._res !== res) return

          this._res = null
          this._idle = true

          if (this._close) this._socket.end()
          else this._socket.emit('free')
        })

        this._req.emit('response', res)
        break
      }

      case DATA:
        // A push that does not fit is the signal to stop reading the socket
        // until the consumer has caught up.
        if (this._res && this._res.push(op.data) === false) this._backpressure = true
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

  _onhandover(data, event) {
    const pending = this._pending

    this._pending = []
    this._ops = null

    this._detach()

    const res = this._res
    const req = this._req

    res._upgrade = req._upgrade = true

    // Anything read past the response belongs to the new protocol, whether the
    // parser had got to it yet or not.
    const head = pending.length === 0 ? data || EMPTY : Buffer.concat([data || EMPTY, ...pending])

    const handled = req.emit(event, res, this._socket, head)

    res.push(null)
    req.destroy()

    if (!handled) this._socket.destroy()
  }

  _ontimeout() {
    if (this._req) this._req.emit('timeout')
  }

  _ondrain() {
    if (this._req) this._req._continueWrite()
  }

  _pause() {
    if (this._paused) return

    this._paused = true
    this._socket.pause()
  }

  _resume() {
    if (this._paused === false) return

    if (this._backpressure) return

    this._paused = false
    this._socket.resume()
  }

  _detach() {
    this._detached = true

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
