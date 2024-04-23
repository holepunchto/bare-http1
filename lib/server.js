const TCPServer = require('bare-tcp').Server
const HTTPServerConnection = require('./server-connection')

module.exports = class HTTPServer extends TCPServer {
  constructor (onrequest) {
    super({ allowHalfOpen: false })

    this.on('connection', (socket) => new HTTPServerConnection(this, socket))

    if (onrequest) this.on('request', onrequest)
  }
}
