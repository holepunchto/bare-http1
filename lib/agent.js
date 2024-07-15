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
      socket = this._freeSockets.get(name).shift()
      if (this._freeSockets.get(name).length === 0) this._freeSockets.delete(name)

      this.reuseSocket(socket, req)
    } else {
      socket = this.createConnection(opts)

      socket.on('free', () => this._onfree(socket, name))
      socket.on('close', () => this._onremove(socket, name))
    }

    if (!this._sockets.has(name)) this._sockets.set(name, new Set())

    this._sockets.get(name).add(socket)

    req._onSocket(socket, opts)
  }

  destroy () {
    const sets = [this._sockets, this._freeSockets]

    sets.forEach((set) => {
      set.forEach((sockets) => {
        sockets.forEach((socket) => socket.destroy())
      })
    })
  }

  _onfree (socket, name) {
    if (this.keepSocketAlive(socket)) {
      this._onremove(socket, name, false) // remove from agent._sockets

      if (!this._freeSockets.has(name)) this._freeSockets.set(name, [])
      this._freeSockets.get(name).push(socket)
    } else {
      socket.end()
    }
  }

  _onremove (socket, name, all = true) {
    if (this._sockets.has(name)) {
      this._sockets.get(name).delete(socket)

      if (this._sockets.get(name).size === 0) this._sockets.delete(name)
    }

    if (all && this._freeSockets.has(name)) {
      const index = this._freeSockets.get(name).indexOf(socket)
      if (index !== -1) this._freeSockets.get(name).splice(index, 1)

      if (this._freeSockets.get(name).length === 0) this._freeSockets.delete(name)
    }
  }

  static global = new this({ keepAlive: 1000, timeout: 5000 })
}
