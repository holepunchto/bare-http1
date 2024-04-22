exports.constants = require('./lib/constants')

exports.IncomingMessage = require('./lib/incoming-message')
exports.OutgoingMessage = require('./lib/outgoing-message')

exports.Server = require('./lib/server')
exports.ServerResponse = require('./lib/server-response')

exports.createServer = function createServer (onrequest) {
  return new exports.Server(onrequest)
}
