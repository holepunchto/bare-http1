const { Readable } = require('bare-stream')

module.exports = class HTTPIncomingMessage extends Readable {
  constructor (socket, method, url, headers) {
    super()

    this.socket = socket
    this.method = method
    this.url = url
    this.headers = headers

    this.push(null)
  }

  getHeader (name) {
    return this.headers[name.toLowerCase()]
  }

  getHeaders () {
    return { ...this.headers }
  }

  _predestroy () {
    this.socket.destroy()
  }
}
