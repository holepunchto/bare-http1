const http = require('..')

const server = http.createServer((req, res) => {
  res.statusCode = 200
  res.setHeader('Content-Length', 12)
  res.write('hello world!')
  res.end()
})

server.listen(8080, () => {
  console.log(server.address())

  const client = http.request({ port: 8080 }, res => {
    let data = ''
    res
      .on('end', () => console.log(data))
      .on('data', (chunk) => {
        data += chunk
      })
  })
  client.end()
})
