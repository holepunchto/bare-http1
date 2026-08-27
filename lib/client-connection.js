const { isEnding, isFinished } = require('bare-stream')
const HTTPParser = require('bare-http-parser')
const HTTPConnection = require('./connection')
const HTTPIncomingMessage = require('./incoming-message')
const errors = require('./errors')
const { isClosing, isUpgrading } = require('./headers')

const {
  constants: { RESPONSE, DATA, END }
} = HTTPParser

module.exports = class HTTPClientConnection extends HTTPConnection {
  static _connections = new WeakMap()

  static from(socket, opts) {
    return this.for(socket) || new this(socket, opts)
  }

  constructor(socket, opts = {}) {
    const { IncomingMessage = HTTPIncomingMessage } = opts

    super(socket, opts)

    this._IncomingMessage = IncomingMessage

    // Whether the peer has said that it is going to close the connection, in
    // which case the socket must not go back into the agent's pool.
    this._close = false

    // Whether an interim 1xx response is being parsed, whose end does not
    // complete the request.
    this._interim = false

    this._attach()
  }

  request(req) {
    this._req = req

    // A response to HEAD is framed as though it had a body but never carries
    // one, and only the request knows that.
    if (req.method === 'HEAD') this._parser.skipBody()
  }

  // The response has arrived in full, so both messages let go of the socket
  // rather than take it down with them when they are destroyed.
  _complete() {
    // A request that never finished writing would go on sending a body onto a
    // socket the peer has already moved past, so the connection cannot carry
    // another exchange.
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

  // Cuts short whatever is in flight, reporting the error to the response if
  // there is one, as its consumer is the one waiting on it, and to the request
  // otherwise.
  _fail(err = errors.CONNECTION_LOST()) {
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
      res.destroy(err)
    }

    if (req !== null) {
      if (res === null) req.destroy(err)
      else req.destroy()
    }
  }

  _continue() {
    while (this._stopped === false) {
      let op

      // Nothing that cannot be parsed, or that the consumer cannot be handed,
      // leaves the connection in a state worth carrying on from.
      try {
        op = this._pullOp()

        if (op === null) break

        this._dispatch(op)
      } catch (err) {
        return this._socket.destroy(err)
      }

      if (this._backpressure) return this._pause()
    }

    if (this._stopped) return

    this._resume()

    if (this._ended) this._endInput()
  }

  _endInput() {
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
    else this._fail()
  }

  _dispatch(op) {
    switch (op.type) {
      case RESPONSE:
        return this._response(op)

      case DATA:
        // A push that does not fit is the signal to stop reading the socket
        // until the consumer has caught up.
        if (this._res && this._res.push(op.data) === false) this._backpressure = true
        break

      case END:
        // The end of an interim response does not complete the request.
        if (this._interim) {
          this._interim = false
          break
        }

        this._complete()
        break
    }
  }

  _response(op) {
    // A peer that answers of its own accord, or answers the same request twice,
    // is trying to get a response of its choosing paired up with whatever
    // request comes next on the connection.
    if (this._req === null || this._res !== null) throw errors.UNEXPECTED_RESPONSE()

    const httpVersion = op.version === 'HTTP/1.0' ? '1.0' : '1.1'

    const upgrade = isUpgrading(op.headers)

    // A 2xx to CONNECT means the tunnel is open, so everything past the headers
    // belongs to it rather than to HTTP.
    const tunnel = this._req.method === 'CONNECT' && op.code >= 200 && op.code < 300

    // A 101 that names no protocol has nothing to hand the connection over to,
    // so it is delivered as the response it claims to be, as Node.js does.
    const switching = op.code === 101 && upgrade === false

    // An interim 1xx response is not the response to the request; the real one
    // still follows, so the request is left open.
    if (upgrade === false && op.code >= 100 && op.code < 200 && op.code !== 101) {
      return this._information(op, httpVersion)
    }

    const req = this._req

    req.on('close', () => {
      // Only the request the connection is currently on has any say in this. A
      // connection that goes back into the pool may already have been handed the
      // next request by the time this one closes.
      if (this._req !== req) return

      this._req = null
    })

    const res = (this._res = new this._IncomingMessage(this._socket, {
      headers: op.headers,
      httpVersion,
      statusCode: op.code,
      statusMessage: op.reason
    }))

    res._demand = this._demand

    // The parser stops for good at a 101, so a connection that carried one
    // cannot carry another exchange and must not be offered for one.
    this._close = switching || isClosing(op.headers, httpVersion)

    // A socket that is handed over to another protocol is no longer ours to hand
    // back to the agent, so the handler that does so is registered below rather
    // than above this.
    if (upgrade || tunnel) {
      return this._handover(this._parser.drain(), tunnel ? 'connect' : 'upgrade')
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

    req.emit('response', res)
  }

  _information(op, httpVersion) {
    this._interim = true

    // The parser spends `skipBody` on the first set of headers it completes, and
    // an interim response is not the one the request was waiting for.
    if (this._req.method === 'HEAD') this._parser.skipBody()

    this._req.emit('information', {
      httpVersion,
      statusCode: op.code,
      statusMessage: op.reason,
      headers: op.headers
    })
  }

  _handover(data, event) {
    const req = this._req
    const res = this._res
    const head = this._takeover(data)

    res._upgrade = req._upgrade = true

    const handled = req.emit(event, res, this._socket, head)

    res.push(null)
    req.destroy()

    if (!handled) this._socket.destroy()
  }

  _detach() {
    super._detach()

    HTTPClientConnection._connections.delete(this._socket)
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

    // No error of its own, as the close may well have been initiated locally.
    this._fail()
  }

  _ondrain() {
    if (this._req) this._req._continueWrite()
  }

  _ontimeout() {
    if (this._req) this._req.emit('timeout')
  }
}
