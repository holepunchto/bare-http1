const { Writable } = require('bare-stream')
const errors = require('./errors')

module.exports = class HTTPOutgoingMessage extends Writable {
  constructor (socket) {
    super({ mapWritable })

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

    this.socket.write(Buffer.from(this._header()))
    this.headersSent = true
  }

  _header () {
    throw errors.NOT_IMPLEMENTED()
  }

  _predestroy () {
    this.socket.destroy()
  }
}

function mapWritable (data) {
  return typeof data === 'string' ? Buffer.from(data) : data
}
