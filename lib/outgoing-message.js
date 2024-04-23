const { Writable } = require('bare-stream')
const constants = require('./constants')

module.exports = class HTTPOutgoingMessage extends Writable {
  constructor (socket) {
    super({ map: mapToBuffer })

    this.socket = socket
    this.statusCode = 200
    this.statusMessage = null
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

    let h = 'HTTP/1.1 ' + this.statusCode + ' ' + (this.statusMessage === null ? constants.status[this.statusCode] : this.statusMessage) + '\r\n'

    for (const name of Object.keys(this.headers)) {
      const n = name.toLowerCase()
      const v = this.headers[name]

      if (n === 'content-length') this._chunked = false
      if (n === 'connection' && v === 'close') this._close = true

      h += httpCase(n) + ': ' + v + '\r\n'
    }

    if (this._chunked) h += 'Transfer-Encoding: chunked\r\n'

    h += '\r\n'

    this.socket.write(Buffer.from(h))
    this.headersSent = true
  }

  _predestroy () {
    this.socket.destroy()
  }
}

function httpCase (n) {
  let s = ''
  for (const part of n.split('-')) {
    s += (s ? '-' : '') + part.slice(0, 1).toUpperCase() + part.slice(1)
  }
  return s
}

function mapToBuffer (b) {
  return typeof b === 'string' ? Buffer.from(b) : b
}
