const HTTPAgent = require('./agent')
const HTTPOutgoingMessage = require('./outgoing-message').Duplex
const errors = require('./errors')
const { get, has, normalize } = require('./headers')
const validate = require('./validate')

// A content length of no length, however the caller happened to spell it.
const ZERO_RE = /^0+$/

module.exports = class HTTPClientRequest extends HTTPOutgoingMessage {
  constructor(opts = {}, onresponse = null) {
    if (typeof opts === 'function') {
      onresponse = opts
      opts = {}
    }

    opts = opts ? { ...opts } : {}

    const agent = opts.agent === false ? new HTTPAgent() : opts.agent || HTTPAgent.global
    const method = opts.method || 'GET'
    const path = opts.path || '/'
    const defaultPort = opts.defaultPort || agent.defaultPort || 80
    const host = (opts.host = opts.host || 'localhost')
    const port = (opts.port = opts.port || defaultPort)

    validate.validateHost(host)
    validate.validateMethod(method)
    validate.validatePath(path)

    const fields = normalize({ host: hostHeader(host, port, defaultPort), ...opts.headers })

    // Credentials named alongside the request, or carried by the URL it was made
    // from, are sent as a header, unless the caller set one for itself.
    if (opts.auth !== undefined && opts.auth !== null && has(fields, 'authorization') === false) {
      fields.authorization = basicAuth(opts.auth)
    }

    super()

    this._headers = fields
    this._method = method
    this._path = path

    // Whether the agent means to take the socket back once the exchange is
    // done, which the peer is only told about when it does not.
    this._keepAlive = agent.keepAlive

    // GET and HEAD requests carry no body unless one is written, in which case
    // it is framed like any other.
    this._expectsBody = method !== 'GET' && method !== 'HEAD'

    // An agent that is already holding as many sockets as it may open has none
    // to give until one comes free, so the request waits and whatever is
    // written meanwhile waits with it.
    this._waiting = false
    this._parked = null

    // Kept here rather than left to the socket, as the agent's own options
    // override the request's and would otherwise displace it.
    this._timeout = opts.timeout === undefined ? null : opts.timeout

    agent.addRequest(this, opts)

    if (onresponse) this.once('response', onresponse)
  }

  get method() {
    return this._method
  }

  get path() {
    return this._path
  }

  // For Node.js compatibility
  abort() {
    return this.destroy()
  }

  // A socket the agent has yet to hand over cannot be given a timeout, so one
  // set before it arrives is kept until it can be.
  setTimeout(ms, ontimeout) {
    this._timeout = ms

    return super.setTimeout(ms, ontimeout)
  }

  // Called by the agent when it has no socket to give the request yet.
  _wait() {
    this._waiting = true
  }

  // And called with the one the request goes out on, whether that was to be had
  // straight away or had to be waited for.
  _onsocket(socket) {
    this._socket = socket
    this._waiting = false

    if (this._timeout !== null) socket.setTimeout(this._timeout)

    this._unpark()

    if (has(this._headers, 'expect')) this._sendExpectation()
  }

  // A caller that announced an expectation is waiting to be answered before it
  // sends its body, and the peer cannot answer headers it has not been sent, so
  // the headers go out ahead of the body rather than with it. Node.js sends them
  // ahead for the same reason.
  _sendExpectation() {
    // Left to a task of its own so that the caller keeps the tick it made the
    // request in to set headers of its own, as it would have with any other
    // request and as Node.js allows.
    queueMicrotask(() => {
      if (this._headersSent || this.destroying || this._socket === null) return

      // An expectation is an offer of a body, so the headers have to frame one
      // even though none has been written yet.
      this._writing = true

      try {
        this.flushHeaders()
      } catch (err) {
        // Nothing is going to be written that would otherwise report this, as
        // the caller is waiting on an answer that is never coming.
        this.destroy(err)
      }
    })
  }

  // Lets go of a write that was waiting on a socket. One let go of because the
  // request is being destroyed finds none and reports it, as any other write
  // onto a message without a socket does.
  _unpark() {
    const parked = this._parked

    if (parked === null) return

    this._parked = null

    parked()
  }

  _write(data, encoding, cb) {
    if (this._waiting) {
      this._parked = () => super._write(data, encoding, cb)

      return
    }

    super._write(data, encoding, cb)
  }

  _final(cb) {
    if (this._waiting) {
      this._parked = () => super._final(cb)

      return
    }

    super._final(cb)
  }

  _predestroy() {
    super._predestroy()

    this._waiting = false

    this._unpark()
  }

  // Everything past a `CONNECT` request line belongs to the tunnel rather than
  // to HTTP, so a request that opens one is not framed at all. An upgrade is not
  // a tunnel yet: RFC 9110 has the peer switch protocols only once the request
  // has been received in full, so its body is framed like any other and the
  // peer is left in no doubt as to where the handover begins.
  _isTunnel() {
    return this._method === 'CONNECT'
  }

  _header() {
    validate.validateMethod(this._method)
    validate.validatePath(this._path)

    let h = `${this._method} ${this._path} HTTP/1.1\r\n` + this._fields()

    // A connection that is not going back into a pool carries nothing after
    // this exchange, and a peer that is not told holds it open for as long as
    // its own keep-alive allows. A tunnel is left alone, as the socket is being
    // given to another protocol rather than given up.
    if (
      this._keepAlive === false &&
      this._isTunnel() === false &&
      has(this._headers, 'connection') === false
    ) {
      h += 'Connection: close\r\n'
    }

    return h + '\r\n'
  }

  _frame(length = -1) {
    if (this._isTunnel()) return

    // A method that carries no body by default is sent without any framing at
    // all unless one is actually being written, since a peer that is promised a
    // body of unknown length reads whatever follows the headers as one. A
    // length the caller announced that the absent body already satisfies is the
    // exception, as it leaves the peer nothing to wait for.
    if (
      length <= 0 &&
      this._expectsBody === false &&
      this._writing === false &&
      announcesEmptyBody(this._headers) === false
    ) {
      return this._frameNone()
    }

    super._frame(length)
  }

  _frameEmpty() {
    this._frame(0)
  }

  // Sends the headers with nothing to follow them, dropping any framing the
  // caller announced: nothing is going to arrive, and the peer would either wait
  // for a body that never comes or read the next request as one. A length of
  // zero is what holds anything written afterwards to that, as there is no
  // longer anywhere to frame it.
  _frameNone() {
    delete this._headers['transfer-encoding']
    delete this._headers['content-length']

    this._length = 0
  }

  _mismatch(written) {
    // Nothing was announced, so there is nothing for the body to be measured
    // against: there is simply nowhere left to put it.
    if (this._length === 0 && has(this._headers, 'content-length') === false) {
      return errors.CONTENT_LENGTH_MISMATCH(
        `Body is ${written} bytes but the request was sent without one`
      )
    }

    return super._mismatch(written)
  }
}

// Whether these fields announce a body of no length, which is exactly what a
// message that carries none has. Anything else the caller announced describes a
// body that is not coming, and only one spelling of no body counts, so that a
// length the message could not be held to is dropped rather than sent.
function announcesEmptyBody(fields) {
  if (has(fields, 'transfer-encoding')) return false

  const length = get(fields, 'content-length')

  if (typeof length === 'number') return length === 0

  return typeof length === 'string' && ZERO_RE.test(length)
}

// https://www.rfc-editor.org/rfc/rfc7617
function basicAuth(credentials) {
  return `Basic ${Buffer.from(String(credentials)).toString('base64')}`
}

function hostHeader(host, port, defaultPort) {
  const i = host.indexOf(':')

  if (i !== -1 && host.includes(':', i + 1) && host.charCodeAt(0) !== 91 /* [ */) {
    host = `[${host}]`
  }

  if (port && +port !== defaultPort) {
    host += ':' + port
  }

  return host
}
