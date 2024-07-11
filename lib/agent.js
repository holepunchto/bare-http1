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

    this._sockets = {}
    this._freeSockets = {}

    this._keepAlive = typeof keepAlive === 'number' ? keepAlive : keepAlive ? keepAliveMsecs : -1

    this._opts = opts
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

  getSocket (opts) {
    opts = { ...opts, ...this._opts }

    const name = this.getName(opts)

    let socket

    if (this._freeSockets[name]) {
      socket = this._freeSockets[name].shift()
      if (this._freeSockets[name].length === 0) delete this._freeSockets[name]

      this.reuseSocket(socket) // TODO: missing `req` parameter
    } else {
      socket = this.createConnection(opts)

      socket.on('free', () => this._onfree(socket, name))
      socket.on('close', () => this._onremove(socket, name))
    }

    if (!this._sockets[name]) this._sockets[name] = []
    this._sockets[name].push(socket)

    return socket
  }

  destroy () {
    const sets = [this._sockets, this._freeSockets]

    sets.forEach((set) => {
      const keys = Object.keys(set)

      keys.forEach((key) => {
        const sockets = set[key]
        sockets.forEach((socket) => socket.destroy())
      })
    })
  }

  _onfree (socket, name) {
    if (this.keepSocketAlive(socket)) {
      this._onremove(socket, name, false) // remove from agent._sockets

      if (!this._freeSockets[name]) this._freeSockets[name] = []
      this._freeSockets[name].push(socket)
    } else {
      socket.end()
    }
  }

  _onremove (socket, name, all = true) {
    const sets = all ? [this._sockets, this._freeSockets] : [this._sockets]

    sets.forEach((sockets) => {
      if (sockets[name]) {
        const index = sockets[name].indexOf(socket)
        if (index !== -1) {
          sockets[name].splice(index, 1)
          if (sockets[name].length === 0) delete sockets[name]
        }
      }
    })
  }

  static global = new this({ keepAlive: 1000, timeout: 5000 })
}
