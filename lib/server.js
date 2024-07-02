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
      const optsClone = JSON.parse(JSON.stringify(opts))
      if (this._timeout) optsClone.timeout = this._timeout

      return new HTTPServerConnection(this, socket, optsClone)
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
}
