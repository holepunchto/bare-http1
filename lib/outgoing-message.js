const { Writable, Duplex, isFinishing } = require('bare-stream')
const HTTPMessage = require('./message')
const errors = require('./errors')
const headers = require('./headers')
const validate = require('./validate')

const CHUNK_DELIMITER = Buffer.from('\r\n')
const CHUNK_TERMINATOR = Buffer.from('0\r\n\r\n')

module.exports = exports = HTTPOutgoingMessage(Writable)

exports.Duplex = HTTPOutgoingMessage(Duplex)

function HTTPOutgoingMessage(Stream) {
  return class HTTPOutgoingMessage extends HTTPMessage(Stream) {
    constructor(socket = null) {
      super(socket)

      this._headersSent = false

      // Whether the body is framed with chunked transfer encoding. Decided when
      // the headers are flushed, as a body that is written in one go can be
      // framed with a content length instead.
      this._chunked = false

      // Whether the framing has been decided, which happens once, before the
      // headers go out; a body with no framing at all runs into whatever
      // follows it on the connection.
      this._framed = false

      // The length the body was announced with, if any, and how much of it has
      // gone out. A body that does not match what the peer was told to read
      // runs over into the next message.
      this._length = -1
      this._written = 0

      this._error = null

      this._pendingWrite = null
    }

    get headersSent() {
      return this._headersSent
    }

    get headers() {
      return this.getHeaders()
    }

    set headers(value) {
      if (this._headersSent) throw errors.HEADERS_SENT()

      this._headers = headers.normalize(value)
    }

    setHeader(name, value) {
      if (this._headersSent) throw errors.HEADERS_SENT()

      validate.validateHeaderName(name)

      const n = name.toLowerCase()

      validate.validateHeaderValue(n, value)

      this._headers[n] = value
    }

    appendHeader(name, value) {
      if (this._headersSent) throw errors.HEADERS_SENT()

      validate.validateHeaderName(name)

      const n = name.toLowerCase()

      validate.validateHeaderValue(n, value)

      const existing = headers.get(this._headers, n)

      this._headers[n] = existing === undefined ? value : [].concat(existing, value)
    }

    flushHeaders() {
      if (this._headersSent === true || this._socket === null) return

      // A caller that sends the headers itself, ahead of writing anything, has
      // the body framed for it here.
      this._frameBody()

      this._socket.write(Buffer.from(this._header(), 'latin1'))
      this._headersSent = true
    }

    write(data, encoding, cb) {
      if (this._headersSent === false && this._socket !== null && this._error === null) {
        // A message that cannot be framed or serialized must not go out half
        // written, so the failure is held for the stream to report rather than
        // thrown from underneath the caller.
        try {
          this.flushHeaders()
        } catch (err) {
          this._error = err
        }
      }

      const flushed = super.write(data, encoding, cb)

      return this._error === null && flushed
    }

    // Takes over the framing headers the caller set for itself, so that exactly
    // one way of delimiting the body ever reaches the wire. Returns whether the
    // caller framed the message, in which case the library leaves it alone.
    _reframe() {
      const encoding = headers.get(this._headers, 'transfer-encoding')

      if (encoding !== undefined) {
        // Chunked is the only transfer coding implemented here, and `_fields`
        // announces it, so the caller's header is taken over rather than sent a
        // second time alongside it.
        if (headers.isToken(encoding, 'chunked') === false) {
          throw errors.INVALID_TRANSFER_ENCODING(
            `Unsupported transfer encoding: ${JSON.stringify(encoding)}`
          )
        }

        delete this._headers['transfer-encoding']

        // RFC 9112 gives Transfer-Encoding precedence over Content-Length, so a
        // peer that reads the other one reads a different message out of the
        // same bytes. Only ever one of them goes out.
        delete this._headers['content-length']

        this._chunked = true

        return true
      }

      const length = headers.get(this._headers, 'content-length')

      if (length !== undefined) {
        this._length = validate.validateContentLength(length)

        // Written back so that the peer reads the same number that the body is
        // held to, whichever way the caller happened to spell it.
        this._headers['content-length'] = this._length.toString()

        return true
      }

      return false
    }

    _frameBody(length = -1) {
      if (this._framed) return

      this._frame(length)

      // A length is only given when the whole body is in hand, so one that does
      // not match what the peer is being told to read is caught before any of
      // the message has gone out.
      if (
        length !== -1 &&
        this._length !== -1 &&
        length !== this._length &&
        this._discardBody() === false
      ) {
        throw this._mismatch(length)
      }

      this._framed = true
    }

    _frameBodyEmpty() {
      if (this._framed) return

      this._frameEmpty()

      this._framed = true
    }

    _frame(length = -1) {
      if (this._reframe()) return

      if (length === -1) this._chunked = true
      else this._frameLength(length)
    }

    _frameLength(length) {
      this._headers['content-length'] = length.toString()
      this._length = length
    }

    // Called when the message ends with nothing having been written.
    _frameEmpty() {
      this._frame(0)
    }

    // Whether the body is held back from the socket. A message that may not
    // carry one still says how long the one it stands in for would have been.
    _discardBody() {
      return false
    }

    // Hook for whatever a message does once its body is on the wire.
    _end() {}

    _header() {
      throw errors.NOT_IMPLEMENTED()
    }

    // Serializes the header fields, which are validated again here so that
    // nothing reaches the wire unchecked.
    _fields() {
      let h = ''

      for (const name of Object.keys(this._headers)) {
        const value = this._headers[name]

        validate.validateHeaderName(name)
        validate.validateHeaderValue(name, value)

        h += headers.serialize(name, value)
      }

      if (this._chunked) h += 'Transfer-Encoding: chunked\r\n'

      return h
    }

    _mismatch(written) {
      return errors.CONTENT_LENGTH_MISMATCH(
        `Body is ${written} bytes but Content-Length is ${this._length}`
      )
    }

    _write(data, encoding, cb) {
      if (this._error !== null) return cb(this._error)

      if (this._socket === null) return cb(errors.CONNECTION_LOST('Message has no socket'))

      if (this._headersSent === false) {
        try {
          this._frameBody(bodyLength(this, data))

          this.flushHeaders()
        } catch (err) {
          return cb(err)
        }
      }

      if (this._discardBody()) return cb(null)

      const written = this._written + data.byteLength

      // Anything past the announced length is read by the peer as the start of
      // the next message on the connection.
      if (this._length !== -1 && written > this._length) return cb(this._mismatch(written))

      this._written = written

      // A zero length chunk is what terminates a chunked body, so writing one
      // before the end would finish the message early and turn whatever came
      // after it into a message of its own.
      if (data.byteLength === 0) return cb(null)

      if (this._chunked) this._socket.write(Buffer.from(`${data.byteLength.toString(16)}\r\n`))

      let flushed = this._socket.write(data)

      // The delimiter is small enough to nearly always fit, so it must not be
      // what decides whether the caller is asked to wait.
      if (this._chunked) flushed = this._socket.write(CHUNK_DELIMITER) && flushed

      if (flushed) cb(null)
      else this._pendingWrite = cb
    }

    _final(cb) {
      if (this._error !== null) return cb(this._error)

      if (this._socket === null) return cb(errors.CONNECTION_LOST('Message has no socket'))

      if (this._headersSent === false) {
        try {
          this._frameBodyEmpty()

          this.flushHeaders()
        } catch (err) {
          return cb(err)
        }
      }

      if (this._discardBody() === false) {
        // A body that stops short of the announced length leaves the peer
        // waiting for the rest, and reading whatever follows as though it were.
        if (this._length !== -1 && this._written !== this._length) {
          return cb(this._mismatch(this._written))
        }

        if (this._chunked) this._socket.write(CHUNK_TERMINATOR)
      }

      this._end()

      cb(null)
    }

    _predestroy() {
      if (this._upgrade === false && this._socket !== null) this._socket.destroy()

      this._continueWrite()
    }

    _continueWrite() {
      if (this._pendingWrite === null) return

      const cb = this._pendingWrite

      this._pendingWrite = null

      cb(null)
    }
  }
}

// The length of the body, when the whole of it is in hand, or -1 when more may
// still be written.
function bodyLength(message, data) {
  if (isFinishing(message) === false) return -1

  return data.byteLength + message._writableState.buffered
}
