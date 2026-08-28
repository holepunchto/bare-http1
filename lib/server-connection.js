const { isEnding, isFinished, isWritable } = require('bare-stream')
const HTTPParser = require('bare-http-parser')
const HTTPConnection = require('./connection')
const HTTPIncomingMessage = require('./incoming-message')
const HTTPServerResponse = require('./server-response')
const errors = require('./errors')
const { hasToken, isClosing, isUpgrading } = require('./headers')
const { destroySoon } = require('./socket')

const {
  constants: { REQUEST, DATA, END }
} = HTTPParser

const BAD_REQUEST = Buffer.from(
  'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
)

const REQUEST_TIMEOUT = Buffer.from(
  'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
)

const HEADERS_TOO_LARGE = Buffer.from(
  'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
)

const PAYLOAD_TOO_LARGE = Buffer.from(
  'HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
)

module.exports = class HTTPServerConnection extends HTTPConnection {
  static _connections = new WeakMap()

  constructor(server, socket, opts = {}) {
    const { IncomingMessage = HTTPIncomingMessage, ServerResponse = HTTPServerResponse } = opts

    super(socket, {
      maxHeaderSize: server.maxHeaderSize,
      maxHeadersCount: server.maxHeadersCount
    })

    this._server = server

    this._IncomingMessage = IncomingMessage
    this._ServerResponse = ServerResponse

    // An operation that has been held back until the connection is free again.
    this._op = null

    this._failed = false
    this._closed = false

    // Whether the connection is closing once the message in hand is answered,
    // whether the peer asked for it or the response gave it up.
    this._closing = false

    // Whether the request in hand has asked for the connection, which is handed
    // over once the whole of it has arrived.
    this._upgrading = false
    this._upgradeBody = 0

    // Whether the request has arrived in full.
    this._received = false

    // Whether the rest of the request body is being thrown away because it was
    // answered without being read.
    this._drained = false

    this._onresponseerror = this._onresponseerror.bind(this)

    // A peer that never finishes sending its request headers would otherwise
    // hold on to the connection for as long as it liked.
    this._headersDeadline = this._deadline(server.headersTimeout, () => this._headersTimeout())

    // And one that finishes the headers but dribbles out the body would hold on
    // to a request as well.
    this._requestDeadline = this._deadline(server.requestTimeout, () => this._requestTimeout())

    // Between requests nothing is being waited on but the next one, which is
    // worth far less patience than an unfinished request: the peer is not
    // mid-anything and is only holding resources here.
    this._keepAliveDeadline = this._deadline(server.keepAliveTimeout, () =>
      this._keepAliveTimeout()
    )

    this._attach()

    if (server.timeout) socket.setTimeout(server.timeout)

    this._headersDeadline.arm()
  }

  get server() {
    return this._server
  }

  get idle() {
    // A connection that has been handed over to another protocol is never idle
    // again.
    return this._idle && this._detached === false
  }

  // Whether the connection has stopped reading for good.
  get _stopped() {
    return this._failed || this._detached || this._closed
  }

  // A request that has arrived in full is left alone: the whole of it is in the
  // hands of its consumer, however much of it they have read, and cutting it
  // short here would throw away a body that `complete` says arrived.
  _abort(err = null) {
    const req = this._req

    if (req === null || isEnding(req) || req.destroying) return

    // Detached before the request is destroyed, as `_predestroy` would otherwise
    // take the socket down with it and throw away whatever response was queued
    // for the peer.
    req._detached = true

    req._abort(err)
  }

  // Gives up on the connection, so that nothing more is read off it and nothing
  // that was read is acted on.
  _stop() {
    this._failed = true

    this._op = null
    this._ops = null
    this._pending = []

    this._clearDeadlines()

    // Nothing more is going to be acted on, so whatever the peer is still
    // sending is left on the socket rather than held here for as long as the
    // socket takes to go away.
    this._pause()
  }

  // Gives up on the connection and takes it down once whatever was written has
  // gone out, so that anything the peer sent behind the last message it will be
  // answered is dropped rather than acted on.
  _hangUp() {
    this._stop()

    destroySoon(this._socket)
  }

  _fail(err, response) {
    this._stop()

    if (this._server.emit('clientError', err, this._socket) === false) {
      // A response that has already begun must not have this one spliced into
      // the middle of it: the peer would count the status line that follows
      // towards the body it was promised.
      if (isWritable(this._socket) && (this._res === null || this._res.headersSent === false)) {
        this._socket.write(response)
      }
    }

    this._abort(err)

    destroySoon(this._socket)
  }

  _continue() {
    while (this._stopped === false) {
      let op = this._op

      if (op !== null) {
        if (this._res !== null) return this._pause()

        this._op = null
      } else {
        try {
          op = this._pullOp()
        } catch (err) {
          return this._failParse(err)
        }

        if (op === null) break

        if (op.type === REQUEST) {
          // The headers are in, whether or not the request can be answered yet.
          this._headersDeadline.disarm()
          this._requestDeadline.arm()

          if (this._res !== null) {
            this._op = op

            return this._pause()
          }
        }
      }

      // Nothing pipelined behind the last message this connection will answer
      // can be answered either, and acting on it anyway is what lets a request
      // an intermediary stopped forwarding be served here.
      if (op.type === REQUEST && this._closing) return this._hangUp()

      this._dispatch(op)

      if (this._backpressure) return this._pause()
    }

    if (this._stopped) return

    this._resume()

    if (this._ended) this._endInput()
  }

  _resume() {
    // A request that is waiting on the response before it must not be read past.
    if (this._op !== null) return

    super._resume()
  }

  _endInput() {
    this._ended = false

    try {
      for (const op of this._parser.end()) this._dispatch(op)
    } catch (err) {
      this._failParse(err)
    }
  }

  _dispatch(op) {
    switch (op.type) {
      case REQUEST:
        return this._request(op)

      case DATA:
        // A push that does not fit is the signal to stop reading the socket
        // until the consumer has caught up. A body held for an upgrade has no
        // consumer until the message it belongs to is finished, so it is taken
        // whole, up to a limit, rather than stalling the handover.
        if (this._upgrading) {
          this._upgradeBody += op.data.byteLength

          if (this._refuseOversizedBody(this._upgradeBody)) return
        }

        if (this._req && this._req.push(op.data) === false && this._upgrading === false) {
          this._backpressure = true
        }
        break

      case END:
        // The request is complete, so an upgrade it asked for takes effect and
        // everything past it belongs to the protocol taking over.
        if (this._upgrading) return this._handover(this._parser.drain(), 'upgrade')

        if (this._req) {
          this._req._detached = true
          this._req._complete = true
          this._req.push(null)
        }

        this._requestDeadline.disarm()
        this._received = true

        this._checkIdle()
        break
    }
  }

  _request(op) {
    this._received = false
    this._drained = false

    const httpVersion = op.version === 'HTTP/1.0' ? '1.0' : '1.1'

    // A peer that says it is closing has nothing left to send once this message
    // is answered, so nothing behind it is read.
    if (isClosing(op.headers, httpVersion)) this._closing = true

    const req = (this._req = new this._IncomingMessage(this._socket, {
      headers: op.headers,
      httpVersion,
      method: op.method,
      url: op.url
    }))

    req._demand = this._demand

    req.on('close', () => {
      // Only the request the connection is currently on has any say in this.
      // One that is closed late, after the next request has been handed the
      // connection, would otherwise leave it without the rest of its body.
      if (this._req !== req) return

      this._req = null

      this._checkIdle()
    })

    // Eagerly open the request stream
    req.resume()
    req.pause()

    // A tunnel is asked for by the method itself, and everything past the
    // request line belongs to it rather than to HTTP.
    if (op.method === 'CONNECT') return this._handover(this._parser.drain(), 'connect')

    // An upgrade only takes effect once the request is complete, so the body
    // belongs to the request and only what follows it to the new protocol. One
    // that nobody is there to take is answered as an ordinary request, as
    // Node.js does.
    if (isUpgrading(op.headers) && this._server.listenerCount('upgrade') > 0) {
      this._upgrading = true
      this._upgradeBody = 0

      const announced = op.headers['content-length']

      if (announced !== undefined) this._refuseOversizedBody(Number(announced))

      return
    }

    const res = (this._res = new this._ServerResponse(this._socket, req, {
      keepAliveTimeout: this._server.keepAliveTimeout
    }))

    res.on('error', this._onresponseerror)

    res.on('close', () => {
      // Only the response the connection is currently on has any say in this,
      // as the request it answered has for its own close.
      if (this._res !== res) return

      this._res = null

      // The response may have given the connection up even where the request
      // did not ask for it.
      if (res._close) this._closing = true

      this._drain()

      this._checkIdle()

      // The connection is free again, so any request that was held back can now
      // be answered.
      this._continue()
    })

    // A client that announced an expectation may be holding its body back until
    // it has been answered. An HTTP/1.0 client is left out, as RFC 9110 gives it
    // no way to understand a 1xx and it would read the 100 as the response
    // itself.
    if (op.headers.expect !== undefined && req.httpVersion !== '1.0') {
      return this._expect(op.headers.expect, req, res)
    }

    this._server.emit('request', req, res)
  }

  _expect(expect, req, res) {
    if (hasToken(expect, '100-continue') === false) {
      if (this._server.listenerCount('checkExpectation') > 0) {
        return this._server.emit('checkExpectation', req, res)
      }

      // Nothing here understands the expectation, and RFC 9110 gives the peer no
      // way to go on without one, so the request is refused.
      res.writeHead(417)
      res.end()

      return
    }

    if (this._server.listenerCount('checkContinue') > 0) {
      return this._server.emit('checkContinue', req, res)
    }

    res.writeContinue()

    this._server.emit('request', req, res)
  }

  _checkIdle() {
    if (this._stopped) return

    // A request whose body has arrived in full is no longer holding on to the
    // connection, however long its consumer takes to read what it was given.
    if (this._res !== null || (this._req !== null && this._received === false)) return

    // A request that is only waiting for the connection to free up is already
    // in hand and about to be answered.
    if (this._op !== null) return

    this._idle = true

    if (this._server.closing) return destroySoon(this._socket)

    // Only started once, as going idle a second time for the same request, when
    // its consumer catches up, must not buy the peer any more time.
    if (this._keepAliveDeadline.armed === false) this._keepAliveDeadline.arm()
  }

  _refuseOversizedBody(length) {
    const max = this._server.maxUpgradeBodySize

    if (max === 0 || length <= max) return false

    this._fail(
      errors.BODY_TOO_LARGE(`Upgrade body exceeds limit of ${max} bytes`),
      PAYLOAD_TOO_LARGE
    )

    return true
  }

  // Throws away the rest of a request body that nobody is reading, as it still
  // has to come off the socket before the next request can be read.
  _drain() {
    const req = this._req

    if (req === null || this._received || this._drained) return

    if (req.listenerCount('data') > 0 || req.listenerCount('readable') > 0) return

    this._drained = true

    req.resume()
  }

  _failParse(err) {
    this._fail(err, err.code === 'HEADER_OVERFLOW' ? HEADERS_TOO_LARGE : BAD_REQUEST)
  }

  // Only ever armed while a request is on its way: from the moment the
  // connection opens until the first one arrives, and from the first byte of
  // every request after that. A connection that is merely being held between
  // requests is on the keep-alive deadline instead, so there is nothing here but
  // a request the peer never finished sending.
  _headersTimeout() {
    this._fail(errors.REQUEST_TIMEOUT('Timed out waiting for the request headers'), REQUEST_TIMEOUT)
  }

  _requestTimeout() {
    this._fail(errors.REQUEST_TIMEOUT('Timed out waiting for the request body'), REQUEST_TIMEOUT)
  }

  // The connection is only being held for another request, so there is nothing
  // to finish: it is given up on outright rather than merely taken down, as a
  // request that had already arrived would otherwise still be acted on, over a
  // socket that is on its way out.
  _keepAliveTimeout() {
    this._hangUp()
  }

  _handover(data, event) {
    const req = this._req
    const head = this._takeover(data)

    req._upgrade = true
    req._complete = true

    const handled = this._server.emit(event, req, this._socket, head)

    req.push(null)

    if (!handled) this._socket.destroy()
  }

  _onerror(err) {
    this._server.emit('clientError', err, this._socket)
  }

  _onclose() {
    this._closed = true

    this._clearDeadlines()

    this._abort(errors.CONNECTION_LOST())

    if (this._res && !isFinished(this._res)) this._res.destroy()
  }

  _ondata(data) {
    // The peer has started on another request, so it is the headers that are on
    // the clock now rather than the connection sitting idle.
    if (this._keepAliveDeadline.armed) {
      this._keepAliveDeadline.disarm()

      if (this._headersDeadline.armed === false) this._headersDeadline.arm()
    }

    super._ondata(data)
  }

  _ondrain() {
    if (this._res) this._res._continueWrite()
  }

  _ontimeout() {
    const reqTimeout = this._req && this._req.emit('timeout')
    const resTimeout = this._res && this._res.emit('timeout')
    const serverTimeout = this._server.emit('timeout', this._socket)

    if (!reqTimeout && !resTimeout && !serverTimeout) this._socket.destroy()
  }

  _onresponseerror(err) {
    this._stop()

    this._server.emit('clientError', err, this._socket)

    this._abort(err)

    // Whatever the peer was promised cannot be finished now, so there is nothing
    // to be gained by letting the rest of the response go out.
    this._socket.destroy()
  }
}
