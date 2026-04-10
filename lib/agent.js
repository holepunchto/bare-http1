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
    if (sockets === undefined) return

    const i = sockets.indexOf(socket)
    if (i === -1) return

    this._size--

    const last = sockets.pop()
    if (last !== socket) sockets[i] = last

    if (sockets.length === 0) this._sockets.delete(name)
  }

  *sockets() {
    for (const sockets of this._sockets.values()) {
      yield* sockets
    }
  }

  *[Symbol.iterator]() {
    for (const [name, sockets] of this._sockets) {
      for (const socket of sockets) yield [name, socket]
    }
  }
}

class HTTPAgent extends EventEmitter {
  constructor(opts = {}) {
    super()

    const { keepAlive = false, keepAliveMsecs = 1000, defaultPort = 80 } = opts

    this._suspended = false
    this._resuming = null

    this._sockets = new HTTPSocketSet()
    this._freeSockets = new HTTPSocketSet()

    this._keepAlive = typeof keepAlive === 'number' ? keepAlive : keepAlive ? keepAliveMsecs : -1
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
    socket.unref()

    return true
  }

  getName(opts) {
    return `${opts.host}:${opts.port}`
  }

  addRequest(req, opts) {
    opts = { ...opts, ...this._opts }

    const name = this.getName(opts)

    let socket = this._freeSockets.pop(name)

    if (socket) this.reuseSocket(socket, req)
    else {
      const agent = this

      socket = this.createConnection(opts)

      socket
        .on('error', noop) // someone needs to handle it
        .on('free', onfree)
        .on('end', onremove)
        .on('finish', onremove)
        .on('close', onremove)
        .on('timeout', ontimeout)

      function onfree() {
        if (socket.destroyed) return

        if (agent.keepSocketAlive(socket)) {
          agent._freeSockets.add(name, socket)
        } else {
          socket.end()
        }

        agent.emit('free', socket)
      }

      function onremove() {
        socket.off('free', onfree)

        agent._sockets.delete(name, socket)
        agent._freeSockets.delete(name, socket)

        if (agent._sockets.size === 0) HTTPAgent._agents.delete(agent)
      }

      function ontimeout() {
        socket.destroy()

        agent._freeSockets.delete(name, socket)
      }
    }

    if (this._sockets.size === 0) HTTPAgent._agents.add(this)

    this._sockets.add(name, socket)

    req._socket = socket

    const connection = HTTPClientConnection.from(socket, opts)

    connection._req = req
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

  static _agents = new Set()

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
