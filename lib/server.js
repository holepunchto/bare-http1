const TCPServer = require('bare-tcp').Server
const HTTPServerConnection = require('./server-connection')

module.exports = class HTTPServer extends TCPServer {
  constructor (opts = {}, onrequest) {
    if (typeof opts === 'function') {
      onrequest = opts
      opts = {}
    }

    super({ allowHalfOpen: false })

    this._timeout = 0
    this._pendingClose = false
    this._requestSockets = new Set()
    this._responseSockets = new Set()

    this.on('connection', (socket) => new HTTPServerConnection(this, socket, opts))

    if (onrequest) this.on('request', onrequest)
  }

  get timeout () {
    return this._timeout || undefined // For Node.js compatibility
  }

  setTimeout (ms = 0, ontimeout) {
    if (ontimeout) this.on('timeout', ontimeout)
    this._timeout = ms
    return this
  }

  close () {
    this._closeConnections()
    if (!this._pendingClose) super.close()
  }

  _checkPendingClose (socket) {
    if (!this._pendingClose) return

    if (!this._isActive(socket)) socket.end()

    if (this._connections.size === 0) {
      this._pendingClose = false
      super.close()
    }
  }

  _closeConnections () {
    for (const socket of this._connections) {
      this._isActive(socket) ? this._pendingClose = true : socket.destroy()
    }
  }

  _isActive (socket) {
    return this._requestSockets.has(socket) || this._responseSockets.has(socket)
  }
}
