exports.IncomingMessage = require('./lib/incoming-message')
exports.OutgoingMessage = require('./lib/outgoing-message')

const Server = exports.Server = require('./lib/server')
exports.ServerResponse = require('./lib/server-response')
exports.ServerConnection = require('./lib/server-connection')

const Request = exports.ClientRequest = require('./lib/client-request')
exports.ClientConnection = require('./lib/client-connection')

exports.constants = require('./lib/constants')

exports.STATUS_CODES = exports.constants.status // For Node.js compatibility

exports.createServer = function createServer (opts, onrequest) {
  return new Server(opts, onrequest)
}

exports.request = function request (url, opts, onresponse) {
  if (typeof opts === 'function') {
    onresponse = opts
    opts = {}
  }

  if (typeof url === 'string') url = new URL(url)

  if (URL.isURL(url)) {
    opts = opts ? { ...opts } : {}

    opts.host = url.hostname
    opts.path = url.pathname + url.search
    opts.port = url.port ? parseInt(url.port, 10) : defaultPort(url)
  } else {
    opts = url
  }

  return new Request(opts, onresponse)
}

// https://url.spec.whatwg.org/#default-port
function defaultPort (url) {
  switch (url.protocol) {
    case 'ftp:': return 21
    case 'http':
    case 'ws': return 80
    case 'https':
    case 'wss': return 443
  }

  return null
}
