# bare-http1

HTTP/1 library for JavaScript.

```
npm i bare-http1
```

Only HTTP servers at the moment and currently does NOT support server request bodies, but supports most other HTTP features (keep-alive, chunked encoding, etc.) and streaming server responses.

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
  console.log('server is bound on', server.address().port)
})
```

## License

Apache-2.0
