const http = require('..')

const server = http.createServer(function (req, res) {
  res.statusCode = 200
  res.setHeader('Content-Length', 12)
  res.write('hello world!')
  res.end()
})

server.listen(8080, function () {
  console.log(server.address())
})
