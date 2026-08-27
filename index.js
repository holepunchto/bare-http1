const errors = require('./lib/errors')

exports.IncomingMessage = require('./lib/incoming-message')
exports.OutgoingMessage = require('./lib/outgoing-message')

exports.Agent = require('./lib/agent')
exports.globalAgent = exports.Agent.global

exports.Server = require('./lib/server')
exports.ServerResponse = require('./lib/server-response')
exports.ServerConnection = require('./lib/server-connection')

exports.ClientRequest = require('./lib/client-request')
exports.ClientConnection = require('./lib/client-connection')

exports.constants = require('./lib/constants')
exports.errors = errors

exports.METHODS = Object.values(exports.constants.method) // For Node.js compatibility
exports.STATUS_CODES = exports.constants.status // For Node.js compatibility

exports.createServer = function createServer(opts, onrequest) {
  return new exports.Server(opts, onrequest)
}

exports.request = function request(url, opts, onresponse) {
  if (typeof opts === 'function') {
    onresponse = opts
    opts = {}
  } else if (opts === undefined || opts === null) {
    opts = {}
  }

  if (typeof url === 'string') url = new URL(url)

  if (isURL(url)) {
    // Every part of the URL is only a default that the options given alongside
    // it may override, as Node.js does.
    const given = opts

    opts = { ...url, ...given }

    if (given.protocol === undefined) opts.protocol = url.protocol
    if (given.path === undefined) opts.path = url.pathname + url.search
    if (given.port === undefined) opts.port = url.port ? parseInt(url.port, 10) : defaultPort(url)

    // The host may be named either way round, so it is only taken from the URL
    // when the caller named it neither way. What the caller did name is put back
    // in case a URL-like object carried its own into the merge.
    opts.host = given.host
    opts.hostname = given.hostname

    if (given.host === undefined && given.hostname === undefined) {
      opts.hostname = hostname(url)
    }
  } else {
    opts = { ...url }
  }

  // For Node.js compatibility
  opts.host = opts.hostname || opts.host
  opts.port = typeof opts.port === 'string' ? parseInt(opts.port, 10) : opts.port

  validateProtocol(opts.protocol)

  return new exports.ClientRequest(opts, onresponse)
}

exports.get = function get(url, opts, onresponse) {
  const req = exports.request(url, opts, onresponse)
  req.end()
  return req
}

// https://url.spec.whatwg.org/#default-port
function defaultPort(url) {
  switch (url.protocol) {
    case 'ftp:':
      return 21
    case 'http:':
    case 'ws:':
      return 80
    case 'https:':
    case 'wss:':
      return 443
  }

  return null
}

function validateProtocol(protocol) {
  if (protocol === undefined || protocol === null) return

  if (protocol !== 'http:' && protocol !== 'ws:') {
    throw errors.INVALID_PROTOCOL(`Unsupported protocol: ${JSON.stringify(protocol)}`)
  }
}

function hostname(url) {
  const host = url.hostname

  return host.charCodeAt(0) === 91 /* [ */ ? host.slice(1, -1) : host
}

// https://url.spec.whatwg.org/#api
function isURL(url) {
  return (
    url !== null &&
    typeof url === 'object' &&
    typeof url.protocol === 'string' &&
    typeof url.hostname === 'string' &&
    typeof url.pathname === 'string' &&
    typeof url.search === 'string'
  )
}
