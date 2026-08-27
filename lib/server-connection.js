const { isEnded, isFinished, isWritable } = require('bare-stream')
const HTTPParser = require('bare-http-parser')
const Deadline = require('./deadline')
const HTTPIncomingMessage = require('./incoming-message')
const HTTPServerResponse = require('./server-response')
const errors = require('./errors')
const { has, hasToken } = require('./headers')

const {
  constants: { REQUEST, DATA, END }
} = HTTPParser

const EMPTY = Buffer.alloc(0)

const BAD_REQUEST = Buffer.from(
  'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
)

const REQUEST_TIMEOUT = Buffer.from(
  'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
)

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

    // Data that has not been handed to the parser yet, the operations that the
    // parser is currently yielding, and an operation that has been held back
    // until the connection is free again.
    this._pending = []
    this._ops = null
    this._op = null

    this._paused = false
    this._ended = false
    this._failed = false
    this._detached = false
    this._closed = false

    // Whether the request has arrived in full. A request that is in hand holds
    // nothing up, however long its consumer takes to read it.
    this._received = false

    // Whether the body is arriving faster than it is being read, in which case
    // the socket is left paused until the consumer asks for more.
    this._backpressure = false

    // Whether anything has been read since the request headers were last waited
    // for, which is the difference between a peer that is being slow about
    // sending a request and one that is simply not sending another.
    this._partial = false

    this._onerror = this._onerror.bind(this)
    this._onclose = this._onclose.bind(this)
    this._onend = this._onend.bind(this)
    this._ondata = this._ondata.bind(this)
    this._ondrain = this._ondrain.bind(this)
    this._ontimeout = this._ontimeout.bind(this)
    this._ondemand = this._ondemand.bind(this)

    // A peer that never finishes sending its request headers would otherwise
    // hold on to the connection for as long as it liked.
    this._headersDeadline = new Deadline(server.headersTimeout, () => this._onheaderstimeout())

    // And one that finishes the headers but dribbles out the body would hold on
    // to a request as well.
    this._requestDeadline = new Deadline(server.requestTimeout, () => this._onrequesttimeout())

    socket
      .on('error', this._onerror)
      .on('close', this._onclose)
      .on('end', this._onend)
      .on('data', this._ondata)
      .on('drain', this._ondrain)
      .on('timeout', this._ontimeout)

    HTTPServerConnection._connections.set(socket, this)

    if (this._server.timeout) socket.setTimeout(this._server.timeout)

    this._headersDeadline.arm()
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

  _abort(err = null) {
    if (this._req === null || isEnded(this._req) || this._req.destroying) return

    // Detached from the socket before it is destroyed, as `_predestroy` would
    // otherwise take the socket down with it and throw away whatever response
    // was queued for the peer.
    this._req._socket = null

    this._req.emit('aborted')

    // Only reported as an error if someone is there to hear it, as Node.js
    // does, since an unhandled `error` would take the process down instead.
    if (err !== null && this._req.listenerCount('error') > 0) this._req.destroy(err)
    else this._req.destroy()
  }

  _fail(err, response) {
    this._failed = true

    this._op = null
    this._ops = null
    this._pending = []

    this._cleartimers()

    if (this._server.emit('clientError', err, this._socket) === false) {
      // A peer that has already stopped writing is on its way out and cannot be
      // written to any more, and a response that has already begun must not have
      // this one spliced into the middle of it: the peer counts the status line
      // that follows towards the body it was promised, and reads whatever is
      // left over as the start of the next response.
      if (isWritable(this._socket) && (this._res === null || this._res.headersSent === false)) {
        this._socket.write(response)
      }
    }

    this._abort(err)

    this._socket.end()
  }

  _continue() {
    while (this._failed === false && this._detached === false) {
      if (this._op !== null) {
        if (this._res !== null) return this._pause()

        const op = this._op
        this._op = null

        this._onop(op)

        if (this._backpressure) return this._pause()
        continue
      }

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

        return this._onparseerror(err)
      }

      if (op.type === REQUEST) {
        // The headers are in, whether or not the request can be answered yet.
        this._headersDeadline.disarm()
        this._requestDeadline.arm()

        if (this._res !== null) {
          this._op = op

          return this._pause()
        }
      }

      this._onop(op)

      if (this._backpressure) return this._pause()
    }

    if (this._failed || this._detached) return

    this._resume()

    if (this._ended) this._oninputend()
  }

  _cleartimers() {
    this._headersDeadline.disarm()
    this._requestDeadline.disarm()
  }

  _onerror(err) {
    this._server.emit('clientError', err, this._socket)
  }

  _onclose() {
    this._closed = true

    this._cleartimers()

    this._abort(errors.CONNECTION_LOST())

    if (this._res && !isFinished(this._res)) this._res.destroy()
  }

  _onend() {
    this._ended = true

    this._continue()
  }

  _ondata(data) {
    this._idle = false
    this._partial = true

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

    try {
      for (const op of this._parser.end()) this._onop(op)
    } catch (err) {
      this._onparseerror(err)
    }
  }

  _onop(op) {
    switch (op.type) {
      case REQUEST: {
        this._received = false

        const req = (this._req = new this._IncomingMessage(this._socket, {
          headers: op.headers,
          httpVersion: op.version === 'HTTP/1.0' ? '1.0' : '1.1',
          method: op.method,
          url: op.url
        }))

        req._ondemand = this._ondemand

        req.on('close', () => {
          // Only the request the connection is currently on has any say in
          // this. One that is closed late, after the next request has already
          // been handed the connection, would otherwise take it away from it
          // and leave that request without the rest of its body.
          if (this._req !== req) return

          this._req = null

          this._onidle()
        })

        // Eagerly open the request stream
        this._req.resume()
        this._req.pause()

        // A tunnel is asked for by the method itself, and everything past the
        // request line belongs to it rather than to HTTP.
        if (op.method === 'CONNECT') {
          return this._onhandover(this._parser.drain(), 'connect')
        }

        // An upgrade needs both the `Upgrade` header naming the protocol and a
        // `Connection` header listing it, as Node.js requires. Going on the
        // latter alone would let an ordinary request take the socket away from
        // the request handler.
        if (has(op.headers, 'upgrade') && hasToken(op.headers.connection, 'upgrade')) {
          return this._onhandover(this._parser.drain(), 'upgrade')
        }

        this._res = new this._ServerResponse(this._socket, this._req)

        this._res.on('close', () => {
          this._res = null

          this._onidle()

          // The connection is free again, so any request that was held back can
          // now be answered.
          this._continue()
        })

        // A client that asked whether to send its body will not send it until
        // it has been told, so it has to be answered one way or the other. An
        // HTTP/1.0 client is never answered, as RFC 9110 gives it no way to
        // understand a 1xx and it would read the 100 as the response itself.
        if (this._req.httpVersion !== '1.0' && hasToken(op.headers.expect, '100-continue')) {
          if (this._server.emit('checkContinue', this._req, this._res)) break

          this._res.writeContinue()
        }

        this._server.emit('request', this._req, this._res)
        break
      }

      case DATA:
        // A push that does not fit is the signal to stop reading the socket
        // until the consumer has caught up.
        if (this._req && this._req.push(op.data) === false) this._backpressure = true
        break

      case END:
        if (this._req) {
          this._req._socket = null
          this._req.push(null)
        }

        // The request is in, so nothing more is being waited on for it.
        this._requestDeadline.disarm()
        this._partial = false
        this._received = true

        this._onidle()
        break
    }
  }

  _onidle() {
    if (this._failed || this._detached || this._closed) return

    // A request whose body has arrived in full is no longer holding on to the
    // connection, however long its consumer takes to read what it was given.
    if (this._res !== null || (this._req !== null && this._received === false)) return

    this._idle = true

    if (this._server.closing) return this._socket.end()

    // Nothing is left to wait for but the next request, if the peer sends one
    // at all, so it is the headers that are on the clock again. The deadline is
    // only started once, as going idle a second time for the same request, when
    // its consumer catches up, must not buy the peer any more time.
    if (this._headersDeadline.armed === false) this._headersDeadline.arm()
  }

  _onparseerror(err) {
    this._fail(err, BAD_REQUEST)
  }

  _onheaderstimeout() {
    if (this._partial === false) {
      // Nothing was being waited for beyond another request, so this is just an
      // idle connection being reclaimed rather than a request going unfinished.
      this._cleartimers()

      return this._socket.end()
    }

    this._fail(errors.REQUEST_TIMEOUT('Timed out waiting for the request headers'), REQUEST_TIMEOUT)
  }

  _onrequesttimeout() {
    this._failed = true

    this._op = null
    this._ops = null
    this._pending = []

    this._cleartimers()

    const err = errors.REQUEST_TIMEOUT('Timed out waiting for the request body')

    // A body that is never going to arrive leaves the request unanswerable
    // either way, so the connection goes regardless of who handled this.
    this._server.emit('clientError', err, this._socket)

    this._abort(err)

    this._socket.destroy()
  }

  _onhandover(data, event) {
    const pending = this._pending

    this._pending = []
    this._ops = null

    this._detach()

    const req = this._req

    req._upgrade = true

    // Anything read past the request belongs to the new protocol, whether the
    // parser had got to it yet or not.
    const head = pending.length === 0 ? data || EMPTY : Buffer.concat([data || EMPTY, ...pending])

    const handled = this._server.emit(event, req, this._socket, head)

    req.push(null)

    if (!handled) this._socket.destroy()
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

  _pause() {
    if (this._paused) return

    this._paused = true
    this._socket.pause()

    this._headersDeadline.suspend()
    this._requestDeadline.suspend()
  }

  _resume() {
    if (this._paused === false) return

    // There is still a reason to leave the socket alone: either the body is not
    // being read, or a request is waiting on the response before it.
    if (this._backpressure || this._op !== null) return

    this._paused = false
    this._socket.resume()

    this._headersDeadline.resume()
    this._requestDeadline.resume()
  }

  _detach() {
    this._detached = true

    this._cleartimers()

    this._socket
      .off('error', this._onerror)
      .off('close', this._onclose)
      .off('end', this._onend)
      .off('data', this._ondata)
      .off('drain', this._ondrain)
      .off('timeout', this._ontimeout)

    HTTPServerConnection._connections.delete(this._socket)
  }
}
