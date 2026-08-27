const HTTPParser = require('bare-http-parser')
const Deadline = require('./deadline')

const EMPTY = Buffer.alloc(0)

// The socket side of an HTTP connection: reading a stream of messages off a
// socket, whichever end of the exchange this is.
module.exports = class HTTPConnection {
  static for(socket) {
    return this._connections.get(socket) || null
  }

  constructor(socket, opts = {}) {
    const { maxHeaderSize, maxHeadersCount } = opts

    this._socket = socket
    this._parser = new HTTPParser({ maxHeaderSize, maxHeadersCount })

    this._req = null
    this._res = null

    this._idle = true

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

    this._deadlines = []

    this._onerror = this._onerror.bind(this)
    this._onclose = this._onclose.bind(this)
    this._onend = this._onend.bind(this)
    this._ondata = this._ondata.bind(this)
    this._ondrain = this._ondrain.bind(this)
    this._ontimeout = this._ontimeout.bind(this)
    this._demand = this._demand.bind(this)
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

  // Deadlines made here are suspended for as long as the socket is, so that
  // none of them count time spent waiting on this side.
  _deadline(ms, onexpire) {
    const deadline = new Deadline(ms, onexpire)

    this._deadlines.push(deadline)

    return deadline
  }

  _clearDeadlines() {
    for (const deadline of this._deadlines) deadline.disarm()
  }

  // The next operation the parser has for the input in hand, or null when it
  // has none left. Throws if the input cannot be parsed.
  _pullOp() {
    while (true) {
      if (this._ops === null) {
        if (this._pending.length === 0) return null

        this._ops = this._parser.push(this._pending.shift())
      }

      let next

      try {
        next = this._ops.next()
      } catch (err) {
        this._ops = null

        throw err
      }

      if (next.done === false) return next.value

      this._ops = null
    }
  }

  _demand() {
    if (this._backpressure === false) return

    this._backpressure = false

    this._continue()
  }

  // Detaches from the socket and hands back everything that was read past the
  // message, which belongs to whatever protocol is taking the socket over,
  // whether the parser had got to it yet or not.
  _takeover(data) {
    const pending = this._pending

    this._pending = []
    this._ops = null

    this._detach()

    const head = data || EMPTY

    return pending.length === 0 ? head : Buffer.concat([head, ...pending])
  }

  _pause() {
    if (this._paused) return

    this._paused = true
    this._socket.pause()

    for (const deadline of this._deadlines) deadline.suspend()
  }

  _resume() {
    if (this._paused === false) return

    // The body is not being read, so there is still a reason to leave the
    // socket alone.
    if (this._backpressure) return

    this._paused = false
    this._socket.resume()

    for (const deadline of this._deadlines) deadline.resume()
  }

  _attach() {
    this._socket
      .on('error', this._onerror)
      .on('close', this._onclose)
      .on('end', this._onend)
      .on('data', this._ondata)
      .on('drain', this._ondrain)
      .on('timeout', this._ontimeout)

    this.constructor._connections.set(this._socket, this)
  }

  _detach() {
    this._detached = true

    this._clearDeadlines()

    this._socket
      .off('error', this._onerror)
      .off('close', this._onclose)
      .off('end', this._onend)
      .off('data', this._ondata)
      .off('drain', this._ondrain)
      .off('timeout', this._ontimeout)
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
}
