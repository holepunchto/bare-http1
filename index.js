const EventEmitter = require('bare-events')
const tcp = require('bare-tcp')
const { Writable, Readable } = require('streamx')
const constants = require('./lib/constants')

class HTTPSocket {
  constructor (server, socket) {
    this._server = server
    this._socket = socket
    this._requests = new Set()
    this._responses = new Set()
    this._buffer = null

    this._socket
      .on('error', this._onerror.bind(this))
      .on('data', this._ondata.bind(this))
      .on('drain', this._ondrain.bind(this))
  }

  _onerror (err) {
    this._socket.destroy(err)
  }

  _ondata (data) {
    if (this._buffer !== null) {
      this._buffer = Buffer.concat([this._buffer, data])
    } else {
      this._buffer = data
    }

    let hits = 0

    for (let i = 0; i < this._buffer.byteLength; i++) {
      const b = this._buffer[i]

      if (hits === 0 && b === 13) {
        hits++
      } else if (hits === 1 && b === 10) {
        hits++
      } else if (hits === 2 && b === 13) {
        hits++
      } else if (hits === 3 && b === 10) {
        hits = 0

        const head = this._buffer.subarray(0, i + 1)
        this._buffer = i + 1 === this._buffer.byteLength ? null : this._buffer.subarray(i + 1)
        this._onrequest(head)

        if (this._buffer === null) break
      } else {
        hits = 0
      }
    }
  }

  _onrequest (head) {
    const r = head.toString().trim().split('\r\n')
    if (r.length === 0) return this._socket.destroy()

    const [method, url] = r[0].split(' ')
    if (!method || !url) return this._socket.destroy()

    const headers = {}

    for (let i = 1; i < r.length; i++) {
      const [name, value] = r[i].split(': ')
      headers[name.toLowerCase()] = value
    }

    const req = new IncomingMessage(this._socket, method, url, headers)
    const res = new ServerResponse(this._socket, req, headers.connection === 'close')

    this._requests.add(req)
    this._responses.add(res)

    req.on('close', () => {
      this._requests.delete(req)
      this._responses.delete(res)
    })

    this._server.emit('request', req, res)
  }

  _ondrain () {
    for (const res of this._responses) res._continueWrite()
  }
}

exports.Server = class HTTPServer extends EventEmitter {
  constructor (onrequest) {
    super()

    this._server = new tcp.Server(this._onconnection.bind(this))
    this._connections = new Set()

    if (onrequest) this.on('request', onrequest)
  }

  close (onclose) {
    this._server.close(onclose)
  }

  address () {
    return this._server.address()
  }

  listen (port, host = '0.0.0.0', onlistening) {
    if (typeof port === 'function') {
      onlistening = port
      port = 0
    } else if (typeof host === 'function') {
      onlistening = host
      host = '0.0.0.0'
    }

    try {
      this._server.listen(port, host, this._onlistening.bind(this))
    } catch (err) {
      queueMicrotask(() => {
        this.emit('error', err) // For Node.js compatibility
      })

      return this
    }

    if (onlistening) this.once('listening', onlistening)

    return this
  }

  ref () {
    this._server.ref()
  }

  unref () {
    this._server.unref()
  }

  _onconnection (socket) {
    const connection = new HTTPSocket(this, socket)

    this._connections.add(connection)

    socket.on('close', () => this._connections.delete(connection))

    this.emit('connection', socket)
  }

  _onlistening () {
    this.emit('listening')
  }
}

const IncomingMessage = exports.IncomingMessage = class IncomingMessage extends Readable {
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

const OutgoingMessage = exports.OutgoingMessage = class OutgoingMessage extends Writable {
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

const ServerResponse = exports.ServerResponse = class ServerResponse extends OutgoingMessage {
  constructor (socket, req, close) {
    super(socket)

    this.req = req

    this._chunked = true
    this._close = close
    this._finishing = false
    this._onlyHeaders = req.method === 'HEAD'

    this._pendingWrite = null
  }

  end (data) {
    this._finishing = true
    return super.end(data)
  }

  writeHead (statusCode, statusMessage = null, headers = {}) {
    if (typeof statusMessage !== 'string') {
      headers = statusMessage
      statusMessage = {}
    }

    this.statusCode = statusCode
    this.statusMessage = statusMessage
    this.headers = headers
  }

  _write (data, cb) {
    if (this.headersSent === false) {
      if (this._finishing) {
        this.setHeader('Content-Length', (data.byteLength + this._writableState.buffered).toString())
      }

      this.flushHeaders()
    }

    if (this._onlyHeaders === true) return cb(null)

    if (this._chunked) {
      data = Buffer.concat([
        Buffer.from('' + data.byteLength.toString(16) + '\r\n'),
        data,
        Buffer.from('\r\n')
      ])
    }

    if (this.socket.write(data)) cb(null)
    else this._pendingWrite = cb
  }

  _final (cb) {
    if (this.headersSent === false) {
      this.setHeader('Content-Length', '0')
      this.flushHeaders()
    }

    if (this._chunked && this._onlyHeaders === false) this.socket.write(Buffer.from('0\r\n\r\n'))
    if (this._close) this.socket.end()

    cb(null)
  }

  _predestroy () {
    super._predestroy()
    this.req.destroy()
    this._continueWrite()
  }

  _continueWrite () {
    if (this._pendingWrite === null) return
    const cb = this._pendingWrite
    this._pendingWrite = null
    cb(null)
  }
}

exports.constants = constants

exports.createServer = function createServer (onrequest) {
  return new exports.Server(onrequest)
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
