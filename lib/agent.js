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

  count(name) {
    const sockets = this._sockets.get(name)

    return sockets === undefined ? 0 : sockets.length
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

    const {
      keepAlive = false,
      keepAliveMsecs = 1000,
      defaultPort = 80,
      maxSockets = Infinity,
      maxFreeSockets = 256,
      maxTotalSockets = Infinity
    } = opts

    this._suspended = false
    this._resuming = null

    this._sockets = new HTTPSocketSet()
    this._freeSockets = new HTTPSocketSet()

    // Requests that are waiting for a socket, as the agent is already holding
    // as many as it may open for them.
    this._queued = new Map()

    this._keepAlive = keepAlive ? (typeof keepAlive === 'number' ? keepAlive : keepAliveMsecs) : -1
    this._defaultPort = defaultPort

    this._maxSockets = maxSockets
    this._maxFreeSockets = maxFreeSockets
    this._maxTotalSockets = maxTotalSockets

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

  get maxSockets() {
    return this._maxSockets
  }

  set maxSockets(value) {
    this._maxSockets = value
  }

  get maxFreeSockets() {
    return this._maxFreeSockets
  }

  set maxFreeSockets(value) {
    this._maxFreeSockets = value
  }

  get maxTotalSockets() {
    return this._maxTotalSockets
  }

  set maxTotalSockets(value) {
    this._maxTotalSockets = value
  }

  get _held() {
    return this._sockets.size + this._freeSockets.size
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

    if (socket !== null) {
      this._sockets.add(name, socket)

      this.reuseSocket(socket, req)
    } else if (this._full(name)) {
      // As many sockets are open as the agent may hold, so the request waits
      // for one of them to come free rather than opening another.
      return this._enqueue(name, req, opts)
    } else {
      socket = this._connect(name, opts)
    }

    this._serve(socket, req, opts)
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
    for (const socket of this._freeSockets.sockets()) socket.destroy()
  }

  // Whether the agent is holding as many sockets as it may open for this name,
  // in which case a request that cannot have one of them waits for one.
  _full(name) {
    return (
      this._held >= this._maxTotalSockets ||
      this._sockets.count(name) + this._freeSockets.count(name) >= this._maxSockets
    )
  }

  // Whether a socket that has come free is one the agent may keep, or one more
  // than it holds room for and so is let go of instead. One that would sit on
  // the last slot the agent has while a request on another name waits for one
  // is let go of as well, as keeping it would leave that request waiting for
  // as long as the pool held on to it.
  _poolable(name) {
    return (
      this._freeSockets.count(name) < this._maxFreeSockets &&
      this._full(name) === false &&
      (this._queued.size === 0 || this._held + 1 < this._maxTotalSockets)
    )
  }

  // Hands a request the socket it goes out on, which may be one it waited for.
  _serve(socket, req, opts) {
    HTTPClientConnection.from(socket, opts).request(req)

    req._onsocket(socket)
  }

  _enqueue(name, req, opts) {
    const queued = this._queued.get(name)
    const pending = { name, req, opts }

    if (queued === undefined) this._queued.set(name, [pending])
    else queued.push(pending)

    req._wait()

    // A request that is given up on while it waits is owed nothing.
    req.on('close', () => this._remove(pending))
  }

  _remove(pending) {
    const queued = this._queued.get(pending.name)
    if (queued === undefined) return

    const i = queued.indexOf(pending)
    if (i === -1) return

    queued.splice(i, 1)

    if (queued.length === 0) this._queued.delete(pending.name)
  }

  // The next request still waiting on this name, or null when none is.
  _shift(name) {
    const queued = this._queued.get(name)
    if (queued === undefined) return null

    let pending = null

    while (queued.length > 0) {
      const next = queued.shift()

      if (next.req.destroying === false) {
        pending = next
        break
      }
    }

    if (queued.length === 0) this._queued.delete(name)

    return pending
  }

  // The next request that is waiting and that the agent now has room to open a
  // socket for, or null when there is none. The name the room came free on is
  // taken first, so that a request is not left behind one on another origin.
  _next(name) {
    if (this._full(name) === false) {
      const pending = this._shift(name)

      if (pending !== null) return pending
    }

    for (const other of [...this._queued.keys()]) {
      if (other === name || this._full(other)) continue

      const pending = this._shift(other)

      if (pending !== null) return pending
    }

    return null
  }

  // Opens sockets for the requests that are waiting, as far as the agent now
  // has room for them.
  _drain(name) {
    while (true) {
      const pending = this._next(name)

      if (pending === null) return

      let socket

      // The agent may have been suspended since the request was made, in which
      // case it is told rather than left waiting on a socket that is never
      // going to be opened for it.
      try {
        socket = this._connect(pending.name, pending.opts)
      } catch (err) {
        pending.req.destroy(err)
        continue
      }

      this._serve(socket, pending.req, pending.opts)
    }
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
      .on('agentRemove', onhandover)

    function onfree() {
      if (socket.destroying) return

      if (agent._sockets.delete(name, socket) === false) return

      // A request that has been waiting for a socket takes this one, rather
      // than being left in the queue while it goes into the pool.
      const pending = agent._shift(name)

      // Never actually free, as it goes straight from one request to the next.
      if (pending !== null) {
        agent._sockets.add(name, socket)

        agent.reuseSocket(socket, pending.req)

        return agent._serve(socket, pending.req, pending.opts)
      }

      if (agent._poolable(name) && agent.keepSocketAlive(socket)) {
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

      // A socket going away is room for a request that has been waiting on one.
      agent._drain(name)

      if (agent._held === 0) HTTPAgent._agents.delete(agent)
    }

    // The socket has been handed over to another protocol and is no longer the
    // agent's to pool, to count, or to take down when either side of it closes.
    // It may outlive every request the agent has, so a slot it went on holding
    // would be one no request could ever have back. Only the error handler is
    // left, as whoever took the socket may still have none of their own.
    function onhandover() {
      socket
        .off('free', onfree)
        .off('end', onhalfclose)
        .off('finish', onhalfclose)
        .off('close', onremove)
        .off('timeout', ontimeout)
        .off('agentRemove', onhandover)

      onremove()
    }

    function ontimeout() {
      // A socket that is in use belongs to whoever is using it, and the timeout
      // is theirs to act on. Only an idle one is reclaimed here, since nobody
      // else is listening for it.
      if (agent._freeSockets.delete(name, socket)) socket.destroy()
    }

    // The agent is only tracked while it holds sockets of its own.
    if (this._held === 0) HTTPAgent._agents.add(this)

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
