const { isEnded, isFinished, isWritable } = require('bare-stream')
const HTTPParser = require('bare-http-parser')
const HTTPIncomingMessage = require('./incoming-message')
const HTTPServerResponse = require('./server-response')
const { hasToken } = require('./headers')

const {
  constants: { REQUEST, DATA, END }
} = HTTPParser

const EMPTY = Buffer.alloc(0)

const BAD_REQUEST = Buffer.from(
  'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
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

  _abort() {
    if (this._req === null || isEnded(this._req) || this._req.destroying) return

    this._req.emit('aborted')
    this._req.destroy()
  }

  _continue() {
    while (this._failed === false && this._detached === false) {
      if (this._op !== null) {
        if (this._res !== null) return this._pause()

        const op = this._op
        this._op = null

        this._onop(op)
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

      if (op.type === REQUEST && this._res !== null) {
        this._op = op

        return this._pause()
      }

      this._onop(op)
    }

    if (this._failed || this._detached) return

    this._resume()

    if (this._ended) this._oninputend()
  }

  _onerror(err) {
    this._server.emit('clientError', err, this._socket)
  }

  _onclose() {
    this._abort()

    if (this._res && !isFinished(this._res)) this._res.destroy()
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
        this._req = new this._IncomingMessage(this._socket, {
          headers: op.headers,
          httpVersion: op.version === 'HTTP/1.0' ? '1.0' : '1.1',
          method: op.method,
          url: op.url
        })

        this._req.on('close', () => {
          this._req = null

          this._onidle()
        })

        // Eagerly open the request stream
        this._req.resume()
        this._req.pause()

        if (hasToken(op.headers.connection, 'upgrade')) {
          return this._onupgrade(this._parser.drain())
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
        // it has been told, so it has to be answered one way or the other.
        if (hasToken(op.headers.expect, '100-continue')) {
          if (this._server.emit('checkContinue', this._req, this._res)) break

          this._res.writeContinue()
        }

        this._server.emit('request', this._req, this._res)
        break
      }

      case DATA:
        if (this._req) this._req.push(op.data)
        break

      case END:
        if (this._req) {
          this._req._socket = null
          this._req.push(null)
        }
        break
    }
  }

  _onidle() {
    if (this._req !== null || this._res !== null) return

    this._idle = true

    if (this._server.closing) this._socket.end()
  }

  _onparseerror(err) {
    this._failed = true

    this._op = null
    this._ops = null
    this._pending = []

    if (this._server.emit('clientError', err, this._socket) === false) {
      // A peer that has already stopped writing is on its way out and cannot be
      // written to any more.
      if (isWritable(this._socket)) this._socket.write(BAD_REQUEST)
    }

    this._abort()

    this._socket.end()
  }

  _onupgrade(data) {
    const pending = this._pending

    this._pending = []
    this._ops = null

    this._detach()

    const req = this._req

    req._upgrade = true

    // Anything read past the request belongs to the upgraded protocol, whether
    // the parser had got to it yet or not.
    const head = pending.length === 0 ? data || EMPTY : Buffer.concat([data || EMPTY, ...pending])

    const upgraded = this._server.emit('upgrade', req, this._socket, head)

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

  _pause() {
    if (this._paused) return

    this._paused = true
    this._socket.pause()
  }

  _resume() {
    if (this._paused === false) return

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

    HTTPServerConnection._connections.delete(this._socket)
  }
}
