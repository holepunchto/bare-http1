const HTTPAgent = require('./agent')
const HTTPOutgoingMessage = require('./outgoing-message').Duplex
const { hasToken, normalize } = require('./headers')
const validate = require('./validate')

module.exports = class HTTPClientRequest extends HTTPOutgoingMessage {
  constructor(opts = {}, onresponse = null) {
    if (typeof opts === 'function') {
      onresponse = opts
      opts = {}
    }

    opts = opts ? { ...opts } : {}

    const agent = opts.agent === false ? new HTTPAgent() : opts.agent || HTTPAgent.global
    const method = opts.method || 'GET'
    const path = opts.path || '/'
    const defaultPort = opts.defaultPort || (agent && agent.defaultPort) || 80
    const host = (opts.host = opts.host || 'localhost')
    const port = (opts.port = opts.port || defaultPort)

    validate.validateMethod(method)
    validate.validatePath(path)

    const fields = normalize({ host: hostHeader(host, port, defaultPort), ...opts.headers })

    super()

    this._headers = fields
    this._method = method
    this._path = path

    // GET and HEAD requests carry no body unless one is written, in which case
    // it is framed like any other.
    this._expectsBody = method !== 'GET' && method !== 'HEAD'

    agent.addRequest(this, opts)

    if (onresponse) this.once('response', onresponse)
  }

  get method() {
    return this._method
  }

  get path() {
    return this._path
  }

  // For Node.js compatibility
  abort() {
    return this.destroy()
  }

  _isHandover() {
    return this._method === 'CONNECT' || hasToken(this._headers.connection, 'upgrade')
  }

  _header() {
    validate.validateMethod(this._method)
    validate.validatePath(this._path)

    return `${this._method} ${this._path} HTTP/1.1\r\n` + this._fields() + '\r\n'
  }

  _frame(length = -1) {
    if (this._isHandover()) return

    super._frame(length)
  }

  _frameEmpty() {
    if (this._isHandover()) return

    if (this._expectsBody) return this._frame(0)

    // A method that carries no body by default is sent without any framing at
    // all. A caller that announced a body anyway has to be corrected, since
    // nothing is going to follow the headers and the peer would either wait for
    // a body that never comes or read the next request as one.
    delete this._headers['transfer-encoding']
    delete this._headers['content-length']
  }
}

function hostHeader(host, port, defaultPort) {
  const i = host.indexOf(':')

  if (i !== -1 && host.includes(':', i + 1) && host.charCodeAt(0) !== 91 /* [ */) {
    host = `[${host}]`
  }

  if (port && +port !== defaultPort) {
    host += ':' + port
  }

  return host
}
