const EventEmitter = require('bare-events')
const tcp = require('bare-tcp')
const HTTPClientConnection = require('./client-connection')

module.exports = class HTTPAgent extends EventEmitter {
  constructor(opts = {}) {
    super()

    const { keepAlive = false, keepAliveMsecs = 1000 } = opts

    this._sockets = new Map()
    this._freeSockets = new Map()

    this._keepAlive = typeof keepAlive === 'number' ? keepAlive : keepAlive ? keepAliveMsecs : -1

    this._opts = { ...opts }
  }

  createConnection(opts) {
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

    let socket

    if (this._freeSockets.has(name)) {
      const sockets = this._freeSockets.get(name)

      socket = sockets.pop()

      if (sockets.length === 0) this._freeSockets.delete(name)

      this.reuseSocket(socket, req)
    } else {
      const agent = this

      socket = this.createConnection(opts)

      socket.on('free', onfree).on('end', onremove).on('finish', onremove).on('timeout', ontimeout)

      function onfree() {
        if (agent.keepSocketAlive(socket)) {
          onremove(false)

          const sockets = agent._freeSockets.get(name)

          if (sockets === undefined) agent._freeSockets.set(name, [socket])
          else sockets.push(socket)
        } else {
          socket.end()
        }

        agent.emit('free', socket)
      }

      function onremove(destroy = true) {
        for (const set of destroy ? [agent._sockets, agent._freeSockets] : [agent._sockets]) {
          const sockets = set.get(name)
          if (sockets === undefined) continue

          const i = sockets.indexOf(socket)
          if (i === -1) continue

          const last = sockets.pop()
          if (last !== socket) sockets[i] = last

          if (sockets.length === 0) set.delete(name)
        }
      }

      function ontimeout(socket, name) {
        const sockets = agent._freeSockets.get(name)
        if (sockets === undefined) return

        const i = sockets.indexOf(socket)
        if (i === -1) return

        const last = sockets.pop()
        if (last !== socket) sockets[i] = last

        if (sockets.length === 0) agent._freeSockets.delete(name)
      }
    }

    const sockets = this._sockets.get(name)

    if (sockets === undefined) this._sockets.set(name, [socket])
    else sockets.push(socket)

    req.socket = socket

    const connection = HTTPClientConnection.from(socket, opts)

    connection.req = req
  }

  destroy() {
    for (const set of [this._sockets, this._freeSockets]) {
      for (const [, sockets] of set) {
        for (const socket of sockets) socket.destroy()
      }
    }
  }

  static global = new this({ keepAlive: 1000, timeout: 5000 })
}
