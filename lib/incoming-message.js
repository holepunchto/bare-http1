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
