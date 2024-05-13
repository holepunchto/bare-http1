# bare-http1

HTTP/1 library for JavaScript.

```
npm i bare-http1
```

Currently HTTP servers does NOT support server request bodies, but supports most other HTTP features (keep-alive, chunked encoding, etc.) and streaming server responses.

Basic HTTP client is supported, but currently it does NOT support keep-alive and protocol negotiation.

## Usage

``` js
const http = require('bare-http1')

// Same API as Node.js

const server = http.createServer(function (req, res) {
  res.statusCode = 200
  res.setHeader('Content-Length', 10)
  res.write('hello world!')
  res.end()
})

server.listen(0, function () {
  const { port } = server.address()
  console.log('server is bound on', port)

  const client = http.request({ port }, res => {
    res.on('data', (data) => console.log(data.toString()))
  })
  client.end()
})
```

## License

Apache-2.0
