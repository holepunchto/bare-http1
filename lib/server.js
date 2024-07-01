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

    this.on('connection', (socket) => {
      const conn = new HTTPServerConnection(this, socket, opts)

      if (this._timeout) {
        socket.setTimeout(this._timeout)
        socket.once('timeout', () => this._ontimeout(conn))
      }
    })

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

  _ontimeout (conn) {
    const reqTimeout = conn.req && conn.req.emit('timeout')
    const resTimeout = conn.res && conn.res.emit('timeout')
    const serverTimeout = this.emit('timeout', conn.socket)

    if (!reqTimeout && !resTimeout && !serverTimeout) conn.socket.destroy()
  }
}
