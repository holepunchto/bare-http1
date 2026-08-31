const { bag, get, has } = require('./headers')
const { validateHeaderNameType } = require('./validate')

// The members that every message has, incoming or outgoing, whichever kind of
// stream it is carried by.
module.exports = function HTTPMessage(Stream) {
  return class HTTPMessage extends Stream {
    constructor(socket = null) {
      super()

      this._socket = socket
      this._upgrade = false
      this._headers = bag()
    }

    get socket() {
      return this._socket
    }

    get upgrade() {
      return this._upgrade
    }

    getHeader(name) {
      validateHeaderNameType(name)

      return get(this._headers, name.toLowerCase())
    }

    getHeaders() {
      return Object.assign(bag(), this._headers)
    }

    hasHeader(name) {
      validateHeaderNameType(name)

      return has(this._headers, name.toLowerCase())
    }

    setTimeout(ms, ontimeout) {
      if (ontimeout) this.once('timeout', ontimeout)

      if (this._socket !== null) this._socket.setTimeout(ms)

      return this
    }
  }
}
