exports.IncomingMessage = require('./lib/incoming-message')
exports.OutgoingMessage = require('./lib/outgoing-message')

const Server = exports.Server = require('./lib/server')
exports.ServerResponse = require('./lib/server-response')

exports.constants = require('./lib/constants')

exports.createServer = function createServer (opts, onrequest) {
  return new Server(opts, onrequest)
}
