const TCPServer = require('bare-tcp').Server
const HTTPServerConnection = require('./server-connection')

module.exports = class HTTPServer extends TCPServer {
  constructor(opts = {}, onrequest) {
    if (typeof opts === 'function') {
      onrequest = opts
      opts = {}
    }

    const { readBufferSize, keepAlive, keepAliveInitialDelay, noDelay, maxConnections } = opts

    // Half open connections are not forwarded, as a client that has stopped
    // writing has nothing left to ask for.
    super({
      readBufferSize,
      keepAlive,
      keepAliveInitialDelay,
      noDelay,
      maxConnections,
      allowHalfOpen: false
    })

    this._timeout = 0

    this.on('connection', (socket) => {
      new HTTPServerConnection(this, socket, opts)
    })

    if (onrequest) this.on('request', onrequest)
  }

  get timeout() {
    return this._timeout || undefined // For Node.js compatibility
  }

  setTimeout(ms = 0, ontimeout) {
    if (ontimeout) this.on('timeout', ontimeout)

    this._timeout = ms

    return this
  }

  close(onclose) {
    super.close(onclose)

    this.closeIdleConnections()

    return this
  }

  closeIdleConnections() {
    for (const socket of this.connections) {
      const connection = HTTPServerConnection.for(socket)

      if (connection === null || connection.idle) socket.destroy()
    }
  }

  closeAllConnections() {
    for (const socket of this.connections) socket.destroy()
  }
}
