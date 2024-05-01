const { Writable } = require('bare-stream')

module.exports = class HTTPOutgoingMessage extends Writable {
  constructor (socket) {
    super({ map: mapToBuffer })

    this.socket = socket
    this.headers = {}
    this.headersSent = false
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

  setHeader (name, value) {
    this.headers[name.toLowerCase()] = value
  }

  flushHeaders () {
    if (this.headersSent === true) return

    const h = this._arrangeHeader()

    this.socket.write(Buffer.from(h))
    this.headersSent = true
  }

  _predestroy () {
    this.socket.destroy()
  }
}

function mapToBuffer (b) {
  return typeof b === 'string' ? Buffer.from(b) : b
}
