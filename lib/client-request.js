const HTTPAgent = require('./agent')
const HTTPOutgoingMessage = require('./outgoing-message').Duplex
const { has, hasToken, normalize } = require('./headers')
const validate = require('./validate')

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
    this._timeout = null

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

  _isHandover() {
    return this._method === 'CONNECT' || hasToken(this._headers.connection, 'upgrade')
  }

  _header() {
    validate.validateMethod(this._method)
    validate.validatePath(this._path)

    let h = `${this._method} ${this._path} HTTP/1.1\r\n` + this._fields()

    // A connection that is not going back into a pool carries nothing after
    // this exchange, and a peer that is not told holds it open for as long as
    // its own keep-alive allows. A handover is left alone, as the socket is
    // being given to another protocol rather than given up.
    if (
      this._keepAlive === false &&
      this._isHandover() === false &&
      has(this._headers, 'connection') === false
    ) {
      h += 'Connection: close\r\n'
    }

    return h + '\r\n'
  }

  _frame(length = -1) {
    if (this._isHandover()) return

    super._frame(length)
  }

  _frameEmpty() {
    if (this._isHandover()) return

    if (this._expectsBody) return this._frame(0)

    // A method that carries no body by default is sent without any framing at
    // all. A caller that announced a body anyway has to be corrected, since
    // nothing is going to follow the headers and the peer would either wait for
    // a body that never comes or read the next request as one.
    delete this._headers['transfer-encoding']
    delete this._headers['content-length']
  }
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
