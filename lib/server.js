const TCPServer = require('bare-tcp').Server
const HTTPServerConnection = require('./server-connection')

// A peer only needs a moment to send a request line and its headers, and never
// needs to keep the connection while it decides.
const DEFAULT_HEADERS_TIMEOUT = 60000

// A body may legitimately take a while to arrive, so this is only a backstop
// against one that never finishes.
const DEFAULT_REQUEST_TIMEOUT = 300000

module.exports = class HTTPServer extends TCPServer {
  constructor(opts = {}, onrequest) {
    if (typeof opts === 'function') {
      onrequest = opts
      opts = {}
    }

    const {
      readBufferSize,
      keepAlive,
      keepAliveInitialDelay,
      noDelay,
      maxConnections,
      headersTimeout = DEFAULT_HEADERS_TIMEOUT,
      requestTimeout = DEFAULT_REQUEST_TIMEOUT
    } = opts

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

    // A request that is never finished would otherwise hold on to a connection
    // for as long as the peer cared to keep it, so the headers and the body are
    // each given a deadline. Neither counts time spent waiting on this side.
    // Zero disables them.
    this._headersTimeout = headersTimeout
    this._requestTimeout = requestTimeout

    this.on('connection', (socket) => {
      new HTTPServerConnection(this, socket, opts)
    })

    if (onrequest) this.on('request', onrequest)
  }

  get timeout() {
    return this._timeout || undefined // For Node.js compatibility
  }

  get headersTimeout() {
    return this._headersTimeout
  }

  set headersTimeout(value) {
    this._headersTimeout = value
  }

  get requestTimeout() {
    return this._requestTimeout
  }

  set requestTimeout(value) {
    this._requestTimeout = value
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
