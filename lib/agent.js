const tcp = require('bare-tcp')

module.exports = class HTTPAgent {
  constructor (opts = {}) {
    const {
      keepAlive = false,
      keepAliveMsecs = 1000,
      maxSockets = Infinity,
      maxTotalSockets = Infinity,
      maxFreeSockets = 256,
      timeout = -1
    } = opts

    this._sockets = new Map()
    this._freeSockets = new Map()

    this._keepAlive = typeof keepAlive === 'number' ? keepAlive : keepAlive ? keepAliveMsecs : -1

    this._opts = { ...opts }
    this._maxSockets = maxSockets
    this._maxTotalSockets = maxTotalSockets
    this._maxFreeSockets = maxFreeSockets
    this._timeout = timeout
  }

  createConnection (opts) {
    return tcp.createConnection(opts)
  }

  reuseSocket (socket, req) {
    socket.ref()
  }

  keepSocketAlive (socket) {
    if (this._keepAlive === -1) return false

    socket.setKeepAlive(true, this._keepAlive)
    socket.unref()

    return true
  }

  getName (opts) {
    return `${opts.host}:${opts.port}`
  }

  addRequest (req, opts) {
    opts = { ...opts, ...this._opts }

    const name = this.getName(opts)

    let socket

    if (this._freeSockets.has(name)) {
      const sockets = this._freeSockets.get(name)
      socket = sockets.values().next().value
      sockets.delete(socket)
      if (sockets.size === 0) this._freeSockets.delete(name)

      this.reuseSocket(socket, req)
    } else {
      socket = this.createConnection(opts)

      socket.on('free', () => this._onfree(socket, name))
      socket.on('close', () => this._onremove(socket, name))
    }

    let sockets = this._sockets.get(name)
    if (sockets === undefined) {
      sockets = new Set()
      this._sockets.set(name, sockets)
    }

    sockets.add(socket)

    req._onsocket(socket, opts)
  }

  destroy () {
    for (const set of [this._sockets, this._freeSockets]) {
      for (const [, sockets] of set) {
        for (const socket of sockets) socket.destroy()
      }
    }
  }

  _onfree (socket, name) {
    if (this.keepSocketAlive(socket)) {
      this._onremove(socket, name, false) // remove from agent._sockets

      let sockets = this._freeSockets.get(name)
      if (sockets === undefined) {
        sockets = new Set()
        this._freeSockets.set(name, sockets)
      }

      sockets.add(socket)
    } else {
      socket.end()
    }
  }

  _onremove (socket, name, all = true) {
    const sets = all ? [this._sockets, this._freeSockets] : [this._sockets]

    for (const set of sets) {
      const sockets = set.get(name)
      if (sockets === undefined) continue

      sockets.delete(socket)
      if (sockets.size === 0) set.delete(name)
    }
  }

  static global = new this({ keepAlive: 1000, timeout: 5000 })
}
