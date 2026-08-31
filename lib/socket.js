const { isFinished, isWritable } = require('bare-stream')

// Closes the write side and then takes the socket down once the last of it has
// gone out.
exports.destroySoon = function destroySoon(socket) {
  if (socket.destroying) return

  if (isWritable(socket)) socket.end()

  if (isFinished(socket)) socket.destroy()
  else socket.once('finish', () => socket.destroy())
}
