const { Readable } = require('bare-stream')

module.exports = class HTTPIncomingMessage extends Readable {
  constructor (socket, headers, args = {}) {
    super()

    this.socket = socket
    this.headers = headers

    // Server arguments
    this.method = args.method || ''
    this.url = args.url || ''

    // Client arguments
    this.statusCode = args.statusCode || 0
    this.statusMessage = args.statusMessage || ''
  }

  get httpVersion () {
    return '1.1'
  }

  getHeader (name) {
    return this.headers[name.toLowerCase()]
  }

  getHeaders () {
    return { ...this.headers }
  }

  hasHeader (name) {
    return name.toLowerCase() in this.headers
  }

  _predestroy () {
    this.socket.destroy()
  }
}
