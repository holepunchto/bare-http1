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

    this._keepAlive = typeof keepAlive === 'number' ? keepAlive : keepAlive ? keepAliveMsecs : -1
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
    return false
  }

  static global = new this({ keepAlive: 1000, timeout: 5000 })
}
