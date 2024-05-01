exports.IncomingMessage = require('./lib/incoming-message')
exports.OutgoingMessage = require('./lib/outgoing-message')

const Server = exports.Server = require('./lib/server')
exports.ServerResponse = require('./lib/server-response')
exports.ServerConnection = require('./lib/server-connection')

const Request = require('./lib/client-request')

exports.constants = require('./lib/constants')

exports.STATUS_CODES = exports.constants.status // For Node.js compatibility

exports.createServer = function createServer (opts, onrequest) {
  return new Server(opts, onrequest)
}

exports.request = function request (opts, onresponse) {
  return new Request(opts, onresponse)
}
