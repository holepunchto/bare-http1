# @pearjs/http

Native HTTP library for JavaScript.

```
npm install @pearjs/http
```

Only HTTP servers at the moment and current does NOT support server request bodies, but supports most other HTTP features (keep-alive, chunked encoding etc) and streaming server responses.

## Usage

``` js
const http = require('@pearjs/http')

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
