const EventEmitter = require('bare-events')
const tcp = require('bare-tcp')
const HTTPClientConnection = require('./client-connection')
const errors = require('./errors')

class HTTPSocketSet {
  constructor() {
    this._sockets = new Map()
    this._size = 0
  }

  get size() {
    return this._size
  }

  add(name, socket) {
    const sockets = this._sockets.get(name)

    this._size++

    if (sockets === undefined) this._sockets.set(name, [socket])
    else sockets.push(socket)
  }

  pop(name) {
    const sockets = this._sockets.get(name)
    if (sockets === undefined || sockets.length === 0) return null

    this._size--

    const last = sockets.pop()

    if (sockets.length === 0) this._sockets.delete(name)

    return last
  }

  delete(name, socket) {
    const sockets = this._sockets.get(name)
    if (sockets === undefined) return false

    const i = sockets.indexOf(socket)
    if (i === -1) return false

    this._size--

    const last = sockets.pop()
    if (last !== socket) sockets[i] = last

    if (sockets.length === 0) this._sockets.delete(name)

    return true
  }

  *sockets() {
    for (const sockets of this._sockets.values()) {
      yield* sockets
    }
  }
}

class HTTPAgent extends EventEmitter {
  static _agents = new Set()

  constructor(opts = {}) {
    super()

    const { keepAlive = false, keepAliveMsecs = 1000, defaultPort = 80 } = opts

    this._suspended = false
    this._resuming = null

    this._sockets = new HTTPSocketSet()
    this._freeSockets = new HTTPSocketSet()

    this._keepAlive = keepAlive ? (typeof keepAlive === 'number' ? keepAlive : keepAliveMsecs) : -1
    this._defaultPort = defaultPort

    this._opts = { ...opts }
  }

  get suspended() {
    return this._suspended
  }

  get resumed() {
    return this._resuming ? this._resuming.promise : null
  }

  get sockets() {
    return this._sockets.sockets()
  }

  get freeSockets() {
    return this._freeSockets.sockets()
  }

  get defaultPort() {
    return this._defaultPort
  }

  get keepAlive() {
    return this._keepAlive !== -1
  }

  createConnection(opts) {
    if (this._suspended) throw errors.AGENT_SUSPENDED()

    return tcp.createConnection(opts)
  }

  reuseSocket(socket, req) {
    socket.ref()
  }

  keepSocketAlive(socket) {
    if (this._keepAlive === -1) return false

    socket.setKeepAlive(true, this._keepAlive)
    socket.setTimeout(0)
    socket.unref()

    if (this._opts.timeout) socket.setTimeout(this._opts.timeout)

    return true
  }

  getName(opts) {
    let name = opts.host || 'localhost'

    name += ':'
    if (opts.port) name += opts.port

    name += ':'
    if (opts.localAddress) name += opts.localAddress

    // Only appended when it was asked for, so that a request that did not care
    // which family it got is not held apart from one that took the same
    // connection anyway.
    if (opts.family === 4 || opts.family === 6) name += `:${opts.family}`

    if (opts.socketPath) name += `:${opts.socketPath}`

    return name
  }

  addRequest(req, opts) {
    opts = { ...opts, ...this._opts }

    const name = this.getName(opts)

    let socket = null

    while ((socket = this._freeSockets.pop(name)) !== null) {
      if (socket.destroying === false) break
    }

    if (socket === null) socket = this._connect(name, opts)
    else this.reuseSocket(socket, req)

    req._socket = socket

    HTTPClientConnection.from(socket, opts).request(req)
  }

  suspend() {
    if (this._suspended) return

    this._resuming = Promise.withResolvers()
    this._suspended = true

    this.destroy()
  }

  resume() {
    if (this._resuming === null) return

    this._resuming.resolve()
    this._resuming = null
    this._suspended = false
  }

  destroy() {
    for (const socket of this._sockets.sockets()) socket.destroy()
  }

  // Opens a socket and keeps track of it for as long as the agent has it.
  _connect(name, opts) {
    const agent = this
    const socket = this.createConnection(opts)

    socket
      .on('error', noop) // Someone needs to handle it
      .on('free', onfree)
      .on('end', onhalfclose)
      .on('finish', onhalfclose)
      .on('close', onremove)
      .on('timeout', ontimeout)

    function onfree() {
      if (socket.destroying) return

      if (agent.keepSocketAlive(socket)) {
        agent._freeSockets.add(name, socket)
      } else {
        socket.end()
      }

      agent.emit('free', socket)
    }

    function onhalfclose() {
      socket.off('free', onfree)

      agent._freeSockets.delete(name, socket)

      socket.destroy()
    }

    function onremove() {
      socket.off('free', onfree)

      agent._sockets.delete(name, socket)
      agent._freeSockets.delete(name, socket)

      if (agent._sockets.size === 0) HTTPAgent._agents.delete(agent)
    }

    function ontimeout() {
      // A socket that is in use belongs to whoever is using it, and the timeout
      // is theirs to act on. Only an idle one is reclaimed here, since nobody
      // else is listening for it.
      if (agent._freeSockets.delete(name, socket)) socket.destroy()
    }

    // The agent is only tracked while it holds sockets of its own.
    if (this._sockets.size === 0) HTTPAgent._agents.add(this)

    this._sockets.add(name, socket)

    return socket
  }

  static _onidle() {
    for (const agent of this._agents) {
      agent.destroy()
    }
  }
}

HTTPAgent.global = new HTTPAgent({ keepAlive: 1000, timeout: 5000 })

module.exports = HTTPAgent

Bare.on('idle', HTTPAgent._onidle.bind(HTTPAgent))

function noop() {}
