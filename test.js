const test = require('brittle')
const tcp = require('bare-tcp')
const http = require('.')

test('basic', async (t) => {
  t.plan(18)

  const server = http.createServer()

  server
    .on('listening', () => t.pass('server listening'))
    .on('connection', (socket) => {
      socket.on('close', () => t.pass('server socket closed'))
    })
    .on('request', (req, res) => {
      t.is(req.method, 'POST')
      t.is(req.url, '/something/?key1=value1&key2=value2&enabled')

      t.is(res.statusCode, 200, 'default status code')
      t.is(res.req, req)
      t.is(res.headersSent, false, 'headers not flushed')
      t.is(req.socket, res.socket)

      res.statusCode = 201
      res.statusMessage = 'All good'

      res.setHeader('Content-Length', 12)
      t.is(res.getHeader('content-length'), 12)
      t.is(res.getHeader('Content-Length'), 12, 'readable in any casing')

      req
        .on('close', () => t.pass('server request closed'))
        .on('data', (data) => t.alike(data, Buffer.from('body message')))

      res
        .on('close', () => {
          t.pass('server response closed')
          t.is(res.headersSent, true, 'headers flushed')
        })
        .end('Hello world!')
    })

  await listen(server)

  const req = await request(
    {
      method: 'POST',
      host: server.address().address,
      port: server.address().port,
      path: '/something/?key1=value1&key2=value2&enabled',
      headers: { 'Content-Length': 12 }
    },
    (client) => client.end('body message')
  )

  t.absent(req.error)
  t.is(req.response.statusCode, 201)
  t.is(req.response.statusMessage, 'All good')
  t.alike(Buffer.concat(req.response.chunks), Buffer.from('Hello world!'))

  await closeServer(server)
})

test('port already in use', async (t) => {
  const server = await listen(http.createServer())

  const err = await new Promise((resolve) =>
    http.createServer().listen(server.address().port).on('error', resolve)
  )

  t.is(err.code, 'EADDRINUSE')

  await closeServer(server)
})

test('destroy request', async (t) => {
  t.plan(3)

  const server = await listen(
    http.createServer((req) => req.on('close', () => t.pass('server request closed')).destroy())
  )

  const req = await request({ port: server.address().port })

  t.absent(req.response, 'client should not receive a response')
  t.ok(req.error, 'client errored')

  await closeServer(server)
})

test('destroy response', async (t) => {
  t.plan(4)

  const server = await listen(
    http.createServer((req, res) => {
      res.destroy()

      req.on('close', () => t.pass('server request closed'))
      res.on('close', () => t.pass('server response closed'))
    })
  )

  const req = await request({ port: server.address().port })

  t.absent(req.response, 'client should not receive a response')
  t.ok(req.error, 'client errored')

  await closeServer(server)
})

test('destroy server socket', async (t) => {
  t.plan(3)

  const server = await listen(
    http
      .createServer(() => t.fail('server should not receive request'))
      .on('connection', (socket) => {
        socket.on('close', () => t.pass('server socket closed')).destroy()
      })
  )

  const req = await request({ port: server.address().port })

  t.absent(req.response)
  t.ok(req.error, 'had error')

  await closeServer(server)
})

test('destroy client socket', async (t) => {
  t.plan(2)

  const server = await listen(http.createServer(() => t.fail('server should not receive request')))

  const req = http.request({ port: server.address().port })

  // Nothing answered the request, so losing the socket under it is a failure of
  // the request, whoever took the socket down.
  req.on('error', (err) => t.is(err.code, 'CONNECTION_LOST', 'request failed'))
  req.on('close', () => t.pass('client socket closed'))

  req.socket.destroy()

  await waitFor(req, 'close')

  await closeServer(server)
})

test('request finishes once its body has been sent', async (t) => {
  t.plan(3)

  const server = await listen(
    http.createServer((req, res) => {
      req.resume().on('end', () => setTimeout(() => res.end('response'), 50))
    })
  )

  const agent = new http.Agent({ port: server.address().port })

  const req = http.request({ agent, method: 'POST' }, (res) => res.resume())

  // Finishing is the body being sent, not the exchange being over: the request
  // is still there to be answered.
  req.on('finish', () => {
    t.pass('request finished')
    t.absent(req.destroyed, 'request still open for the response')
  })

  req.on('close', () => t.pass('request closed once answered'))

  req.end('body')

  await waitFor(req, 'close')

  agent.destroy()

  await closeServer(server)
})

test('destroy request once its body has been sent', async (t) => {
  t.plan(2)

  const server = await listen(
    http.createServer((req, res) => {
      req.resume().on('end', () => setTimeout(() => res.end('response'), 200))
    })
  )

  const agent = new http.Agent({ port: server.address().port })

  const req = http.request({ agent, method: 'POST' }, () => t.fail('response should not arrive'))

  const socket = req.socket

  // Giving up while waiting for the response has to take the connection with
  // it, which is why the request outlives its own body.
  req.on('finish', () => req.destroy())

  req.on('close', () => {
    t.pass('request closed')
    t.ok(socket.destroying, 'connection torn down')
  })

  req.end('body')

  await waitFor(req, 'close')

  agent.destroy()

  await closeServer(server)
})

test('a request the peer abandons part way through is closed', async (t) => {
  let closed = null

  const server = await listen(
    http.createServer((req, res) => {
      req.on('close', () => closed.pass('request closed')).resume()
      res.on('close', () => closed.pass('response closed'))
    })
  )

  for (const request of [
    'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n',
    'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10000000\r\n\r\n'
  ]) {
    closed = t.test(request.slice(0, request.indexOf(' ')))
    closed.plan(2)

    const socket = tcp.createConnection(server.address().port, 'localhost')

    socket.on('error', () => {})
    socket.write(Buffer.from(request))

    setTimeout(() => socket.destroy(), 100)

    await closed
  }

  await closeServer(server)
})

test('connection lost while the response body is arriving', async (t) => {
  const sub = t.test()
  sub.plan(4)

  // Promises a hundred bytes, sends seven, then goes away.
  const server = await rawServer('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial', {
    destroy: true
  })

  const agent = new http.Agent({ port: server.address().port })

  const req = http.request({ agent }, (res) => {
    res
      .on('data', (data) => sub.alike(data, Buffer.from('partial'), 'partial body delivered'))
      // A truncated body must not look like a clean end, and it must not leave
      // the consumer waiting for one either.
      .on('error', (err) => sub.is(err.code, 'CONNECTION_LOST', 'response failed'))
      .on('close', () => {
        sub.absent(res.complete, 'response stopped short')
        sub.pass('response closed')
      })
  })

  // The request was sent in full and answered, so it is not the half that
  // failed.
  req.on('error', () => t.fail('request should not fail'))

  req.end()

  await sub

  agent.destroy()

  await closeServer(server)
})

test('connection lost before the response arrives', async (t) => {
  t.plan(2)

  // Takes the request and goes away without answering it.
  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {})
      socket.once('data', () => socket.end())
    })
  )

  const agent = new http.Agent({ port: server.address().port })

  const req = http.request({ agent }, () => t.fail('no response expected'))

  // Nothing was answered, so the request is the half left outstanding.
  req.on('error', (err) => t.is(err.code, 'CONNECTION_LOST', 'request failed'))
  req.on('close', () => t.pass('request closed'))

  req.end()

  await waitFor(req, 'close')

  agent.destroy()

  await closeServer(server)
})

test('connection lost after the response body has arrived', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await rawServer('HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nresponse', {
    destroy: true
  })

  const agent = new http.Agent({ port: server.address().port })

  const chunks = []

  http
    .request({ agent }, (res) => {
      res
        .on('data', (data) => chunks.push(data))
        // The body is all there, so losing the connection afterwards is not a
        // failure of the response.
        .on('error', () => sub.fail('response should not fail'))
        .on('end', () => sub.alike(Buffer.concat(chunks), Buffer.from('response'), 'body intact'))
        .on('close', () => sub.pass('response closed'))
    })
    .end()

  await sub

  agent.destroy()

  await closeServer(server)
})

test('write head', async (t) => {
  t.plan(6)

  const server = await listen(
    http.createServer((req, res) => {
      req.resume()
      res.writeHead(404, { 'x-custom': 1234 })
      res.end()

      req.on('close', () => t.pass('server request closed'))
      res.on('close', () => t.pass('server response closed'))
    })
  )

  const req = await request({ port: server.address().port })

  t.is(req.response.statusCode, 404)
  t.is(req.response.headers['x-custom'], '1234')
  t.alike(req.response.chunks, [], 'client should not receive data')
  t.ok(req.response.ended, 'client response ended')

  await closeServer(server)
})

test('write head normalises header casing', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.setHeader('content-length', '2')
      // Sending both would be a framing error, so the second has to replace the
      // first rather than sit alongside it.
      res.writeHead(200, { 'Content-Length': '2' })
      res.end('ab')
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.is(raw.match(/^content-length:/gim).length, 1, 'content length sent once')
  t.ok(raw.includes('Content-Length: 2\r\n'), 'content length is the one that was set')
  t.ok(raw.endsWith('\r\n\r\nab'), 'body follows the headers')

  await closeServer(server)
})

test('headers cannot be changed once they have been sent', async (t) => {
  const sub = t.test()
  sub.plan(4)

  const server = await listen(
    http.createServer((req, res) => {
      sub.is(res.headersSent, false, 'headers not sent before writing')

      res.write('chunk')

      // The headers went out with the write, so anything that would change them
      // is too late and has to say so rather than silently take effect.
      sub.is(res.headersSent, true, 'headers sent once written')
      sub.exception(() => res.setHeader('X-Late', '1'), /HEADERS_SENT/, 'setHeader throws')
      sub.exception(() => res.writeHead(500), /HEADERS_SENT/, 'writeHead throws')

      res.end()
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.ok(raw.startsWith('HTTP/1.1 200 OK\r\n'), 'status is the one that was sent')
  t.absent(raw.includes('X-Late'), 'late header not sent')

  await closeServer(server)
})

test('request headers are readable whatever casing they were given in', (t) => {
  const req = http.request({ agent: false, headers: { 'X-Custom': 'value' } })

  t.is(req.getHeader('x-custom'), 'value', 'readable in lower case')
  t.is(req.getHeader('X-Custom'), 'value', 'readable in the original casing')
  t.ok(req.hasHeader('X-Custom'), 'reported as present')
  t.alike(Object.keys(req.getHeaders()).sort(), ['host', 'x-custom'], 'stored in lower case')

  req.destroy()
})

test('chunked', async (t) => {
  t.plan(5)

  const server = await listen(
    http.createServer((req, res) => {
      const chunks = []

      req
        .on('data', (chunk) => chunks.push(chunk))
        .on('end', () =>
          t.alike(
            Buffer.concat(chunks),
            Buffer.from('request body part 1 + request body part 2'),
            'request body ended'
          )
        )
        .on('close', () => t.pass('server request closed'))

      res.on('close', () => t.pass('server response closed'))

      res.write('response part 1 + ')
      setImmediate(() => res.end('response part 2'))
    })
  )

  const req = await request({ method: 'POST', port: server.address().port }, (client) => {
    client.write('request body part 1 + ')
    setImmediate(() => client.end('request body part 2'))
  })

  t.is(req.response.statusCode, 200)
  t.alike(Buffer.concat(req.response.chunks), Buffer.from('response part 1 + response part 2'))

  await closeServer(server)
})

test('chunked request with trailer fields', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      const chunks = []

      req.on('data', (data) => chunks.push(data)).on('end', () => res.end(Buffer.concat(chunks)))
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n' +
      'Transfer-Encoding: chunked\r\n\r\n' +
      '5\r\nhello\r\n0\r\nX-Trailer: value\r\n\r\n'
  )

  t.ok(raw.startsWith('HTTP/1.1 200 OK\r\n'), 'request accepted')
  t.ok(raw.endsWith('\r\n\r\nhello'), 'body received')

  await closeServer(server)
})

test('large request and response body', async (t) => {
  t.plan(5)

  const server = await listen(
    http.createServer((req, res) => {
      const chunks = []

      req
        .on('data', (chunk) => chunks.push(chunk))
        .on('end', () => {
          t.alike(
            Buffer.concat(chunks),
            Buffer.concat([
              Buffer.alloc(2 * 1024 * 1024, 'qwer'),
              Buffer.alloc(2 * 1024 * 1024, 'asdf')
            ])
          )

          res.write(Buffer.alloc(2 * 1024 * 1024, 'abcd'))
          setImmediate(() => res.end(Buffer.alloc(2 * 1024 * 1024, 'efgh')))
        })
        .on('close', () => t.pass('server request closed'))

      res.on('close', () => t.pass('server response closed'))
    })
  )

  const req = await request({ method: 'POST', port: server.address().port }, (client) => {
    client.write(Buffer.alloc(2 * 1024 * 1024, 'qwer'))
    setImmediate(() => client.end(Buffer.alloc(2 * 1024 * 1024, 'asdf')))
  })

  t.ok(req.response.ended)
  t.alike(
    Buffer.concat(req.response.chunks),
    Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 'abcd'), Buffer.alloc(2 * 1024 * 1024, 'efgh')])
  )

  await closeServer(server)
})

test('request body is framed on a method that carries none by default', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    http.createServer((req, res) => {
      const chunks = []

      req
        .on('data', (data) => chunks.push(data))
        // An unframed body is not a body at all: the peer would read it as the
        // start of another request.
        .on('end', () => {
          sub.alike(Buffer.concat(chunks), Buffer.from('body'), 'body received')

          res.end('ok')
        })
    })
  )

  const agent = new http.Agent({ port: server.address().port })

  const result = await request({ agent, method: 'GET' }, (client) => client.end('body'))

  await sub

  t.is(result.response.statusCode, 200, 'request understood')

  agent.destroy()

  await closeServer(server)
})

test('request without a body is not framed as chunked', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await listen(
    http.createServer((req, res) => {
      sub.is(req.headers['transfer-encoding'], undefined, 'not chunked')
      sub.is(req.headers['content-length'], undefined, 'no content length')

      res.end()
    })
  )

  const agent = new http.Agent({ port: server.address().port })

  const result = await request({ agent })

  await sub

  t.is(result.response.statusCode, 200, 'request understood')

  agent.destroy()

  await closeServer(server)
})

test('response to HEAD has no body', async (t) => {
  const sub = t.test()
  sub.plan(3)

  // A HEAD response carries the headers a GET would, content length included,
  // but no body. Waiting for one would hang the exchange.
  const server = await rawServer('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n')

  const agent = new http.Agent({ port: server.address().port })

  http
    .request({ agent, method: 'HEAD' }, (res) => {
      sub.is(res.statusCode, 200, 'status received')
      sub.is(res.getHeader('content-length'), '100', 'length reported')

      res
        .on('data', () => sub.fail('no body expected'))
        .on('end', () => sub.pass('response ended'))
        .resume()
    })
    .end()

  await sub

  agent.destroy()

  await closeServer(server)
})

// A length nothing was written for would describe the resource as empty rather
// than say that no body was generated for it.
test('a HEAD response announces only a length it knows', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.setHeader('connection', 'close')

      switch (req.url) {
        case '/whole':
          return res.end('response')

        case '/streamed':
          res.write('response')
          return res.end()

        case '/declared':
          res.setHeader('content-length', 1234)
          return res.end()

        default:
          return res.end()
      }
    })
  )

  const port = server.address().port

  const head = (path) => rawRequest(port, `HEAD ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`)

  const whole = await head('/whole')
  const streamed = await head('/streamed')
  const declared = await head('/declared')
  const nothing = await head('/nothing')

  t.ok(whole.includes('Content-Length: 8\r\n'), 'a body that was written has its length given')
  t.ok(declared.includes('Content-Length: 1234\r\n'), 'as has one the caller declared itself')

  t.absent(/content-length/i.test(streamed), 'a body of unknown length has none to give')
  t.absent(/transfer-encoding/i.test(streamed), 'and no terminator is promised for it either')

  t.absent(/content-length/i.test(nothing), 'and neither has a body that was never written')

  for (const [name, response] of [
    ['whole', whole],
    ['streamed', streamed],
    ['declared', declared],
    ['nothing', nothing]
  ]) {
    t.ok(response.endsWith('\r\n\r\n'), `nothing follows the headers of ${name}`)
  }

  await closeServer(server)
})

test('response to HEAD does not consume the response after it', async (t) => {
  const sub = t.test()
  sub.plan(4)

  const server = await listen(http.createServer((req, res) => res.end('response')))

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const head = http.request({ agent, method: 'HEAD' }, (res) => {
    sub.is(res.getHeader('content-length'), '8', 'length a GET would have returned')

    res
      .on('data', () => sub.fail('no body expected'))
      .on('end', () => sub.pass('head response ended'))
      .resume()
  })

  const socket = head.socket

  head.on('close', () =>
    setImmediate(() => {
      // On the same socket, so a HEAD response that was read as having a body
      // would have swallowed this one whole.
      const get = http
        .request({ agent }, (res) => {
          sub.is(get.socket, socket, 'socket reused')

          res.on('data', (data) => sub.alike(data, Buffer.from('response'), 'body received'))
        })
        .on('close', () => agent.destroy())

      get.end()
    })
  )

  head.end()

  await sub

  await closeServer(server)
})

test('response delimited by the connection closing', async (t) => {
  const sub = t.test()
  sub.plan(2)

  // Neither a content length nor a transfer encoding, so the body runs until the
  // connection closes.
  const server = await rawServer('HTTP/1.1 200 OK\r\n\r\nresponse', { end: true })

  const agent = new http.Agent({ port: server.address().port })

  const chunks = []

  http
    .request({ agent }, (res) => {
      res
        .on('data', (data) => chunks.push(data))
        .on('error', () => sub.fail('the close ends the body rather than failing it'))
        .on('end', () => sub.alike(Buffer.concat(chunks), Buffer.from('response'), 'body received'))
        .on('close', () => sub.pass('response closed'))
    })
    .end()

  await sub

  agent.destroy()

  await closeServer(server)
})

test('response with a status that carries no body', async (t) => {
  const sub = t.test()
  sub.plan(2)

  // 304 is allowed to carry the content length of the body it is standing in
  // for, without the body itself.
  const server = await rawServer('HTTP/1.1 304 Not Modified\r\nContent-Length: 100\r\n\r\n')

  const agent = new http.Agent({ port: server.address().port })

  http
    .request({ agent }, (res) => {
      sub.is(res.statusCode, 304, 'status received')

      res
        .on('data', () => sub.fail('no body expected'))
        .on('end', () => sub.pass('response ended'))
        .resume()
    })
    .end()

  await sub

  agent.destroy()

  await closeServer(server)
})

test('HTTP/1.0 request', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await listen(
    http.createServer((req, res) => {
      sub.is(req.httpVersion, '1.0', 'version reported')
      sub.is(req.headers.connection, undefined, 'no connection header')

      // Written in two goes, so the body length is not known up front.
      res.write('hello ')
      res.end('world')
    })
  )

  const raw = await rawRequest(server.address().port, 'GET / HTTP/1.0\r\n\r\n')

  await sub

  // HTTP/1.0 has no chunked transfer encoding, so a body of unknown length can
  // only be delimited by closing the connection.
  t.absent(raw.includes('Transfer-Encoding'), 'not chunked')
  t.ok(raw.includes('Connection: close\r\n'), 'connection close announced')
  t.ok(raw.endsWith('\r\n\r\nhello world'), 'body delimited by the close')

  await closeServer(server)
})

test('connection close is honoured whatever its casing', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end('response')))

  // rawRequest only resolves once the peer closes, so the request completing at
  // all is the assertion that the token was understood.
  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Close\r\n\r\n'
  )

  t.ok(raw.endsWith('\r\n\r\nresponse'), 'response received')
  t.ok(raw.includes('Connection: close\r\n'), 'connection close announced')

  await closeServer(server)
})

test('pipelined requests are answered in order', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      // The first request is answered slowest, so responses that are not held
      // back would go out the wrong way round and be read as each other's.
      setTimeout(() => res.end(req.url), req.url === '/first' ? 100 : 0)
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n' +
      'GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.indexOf('/first') < raw.indexOf('/second'), 'answered in request order')
  t.is(raw.split('HTTP/1.1 200 OK').length - 1, 2, 'one response each')

  await closeServer(server)
})

// A peer that said it is closing, or that was told so, gets one more answer and
// no more. Serving what it pipelined behind that message is what lets a request
// an intermediary stopped forwarding be acted on here.
test('a request pipelined behind one that closes the connection is not served', async (t) => {
  const served = []

  const server = await listen(
    http.createServer((req, res) => {
      served.push(req.url)
      res.end(req.url)
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET /first HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' +
      'GET /smuggled HTTP/1.1\r\nHost: localhost\r\n\r\n'
  )

  t.alike(served, ['/first'], 'only the request that could be answered was served')
  t.ok(raw.includes('/first'), 'first request answered')
  t.absent(raw.includes('/smuggled'), 'and nothing came back for the one behind it')

  await closeServer(server)
})

test('a request pipelined behind a response that closes the connection is not served', async (t) => {
  const served = []

  const server = await listen(
    http.createServer((req, res) => {
      served.push(req.url)

      // The request asked for nothing, so it is this side giving the connection
      // up that leaves the one behind it unanswerable.
      res.setHeader('connection', 'close')
      res.end(req.url)
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n' +
      'GET /smuggled HTTP/1.1\r\nHost: localhost\r\n\r\n'
  )

  t.alike(served, ['/first'], 'only the request that could be answered was served')
  t.ok(raw.includes('/first'), 'first request answered')

  await closeServer(server)
})

// An HTTP/1.0 peer that did not ask for the connection to be kept is closing by
// default, so the same holds without it having said anything.
test('an HTTP/1.0 request does not have a pipelined request served behind it', async (t) => {
  const served = []

  const server = await listen(
    http.createServer((req, res) => {
      served.push(req.url)
      res.end(req.url)
    })
  )

  await rawRequest(
    server.address().port,
    'GET /first HTTP/1.0\r\nHost: localhost\r\n\r\n' +
      'GET /smuggled HTTP/1.1\r\nHost: localhost\r\n\r\n'
  )

  t.alike(served, ['/first'], 'only the request that could be answered was served')

  await closeServer(server)
})

test('protocol negotiation', async (t) => {
  const sub = t.test()
  sub.plan(8)

  const server = await listen(http.createServer())

  server.on('upgrade', (req, socket, head) => {
    // The request carries no body, so nothing precedes the handover.
    sub.alike(head, Buffer.alloc(0), 'server upgrade')

    req
      .on('end', () => sub.pass('server request ended'))
      .on('close', () => sub.pass('server request closed'))
      .on('data', () => sub.fail('no request body expected'))
      .on('error', () => sub.fail('the request should not fail'))

    // Whatever the two ends make of the socket now is theirs rather than HTTP's.
    socket.on('data', (data) => {
      sub.alike(data, Buffer.from('client head'), 'server read past the handover')

      socket.end()
    })

    socket.write(
      'HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
        'Upgrade: weird-protocol\r\n' +
        'Connection: Upgrade\r\n' +
        '\r\n' +
        'server head'
    )
  })

  const req = http
    .request({
      port: server.address().port,
      headers: { Connection: 'Upgrade', Upgrade: 'weird-protocol' }
    })
    .end()

  req.on('upgrade', (res, socket, head) => {
    sub.alike(head, Buffer.from('server head'), 'client upgrade')

    req.on('close', () => sub.pass('client request closed'))

    res
      .on('close', () => sub.pass('client response closed'))
      .on('end', () => sub.pass('client response ended'))
      .on('data', () => sub.fail('no response body expected'))
      .on('error', () => sub.fail('the response should not fail'))

    socket.end('client head')
  })

  await sub

  await closeServer(server)
})

// An upgrade only takes effect once the request has been received in full, so a
// body written to one belongs to the request and has to be framed like any
// other. Unframed it would be read as the request that follows.
test('an upgrade request frames the body written to it', async (t) => {
  const served = []

  const server = await listen(
    http.createServer((req, res) => {
      const chunks = []

      req
        .on('data', (data) => chunks.push(data))
        .on('end', () => {
          served.push(
            req.method + ' ' + req.url + ' ' + JSON.stringify(Buffer.concat(chunks).toString())
          )

          res.end('ok')
        })
    })
  )

  const client = http.request({
    port: server.address().port,
    agent: false,
    method: 'POST',
    path: '/upload',
    headers: { connection: 'upgrade', upgrade: 'websocket' }
  })

  client.on('error', () => {})
  client.on('response', (res) => res.resume())

  // Body bytes that look like a request of their own. Unframed they would be
  // read as one.
  client.end('GET /admin HTTP/1.1\r\nHost: localhost\r\n\r\n')

  await pause(200)

  t.alike(
    served,
    ['POST /upload "GET /admin HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n"'],
    'one request reached the server, carrying the whole of the body'
  )

  await closeServer(server)
})

test('an upgrade request that carries no body is not framed for one', async (t) => {
  const seen = []

  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {}).on('data', (data) => seen.push(data.toString()))
    })
  )

  const client = http.request({
    port: server.address().port,
    agent: false,
    headers: { connection: 'upgrade', upgrade: 'websocket' }
  })

  client.on('error', () => {})
  client.end()

  await pause(200)

  const request = seen.join('')

  t.absent(request.includes('Content-Length'), 'no content length')
  t.absent(request.includes('Transfer-Encoding'), 'not chunked')

  await closeServer(server)
})

test('a tunnel is still handed everything written to it', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(http.createServer())

  server.on('connect', (req, socket, head) => {
    sub.alike(head, Buffer.from('tunnel head'), 'the head reached the tunnel')

    socket.destroy()
  })

  const client = http.request({
    port: server.address().port,
    agent: false,
    method: 'CONNECT',
    path: 'localhost:443'
  })

  client.on('error', () => {})
  client.on('connect', (res, socket) => socket.destroy())
  client.end('tunnel head')

  await sub

  await closeServer(server)
})

test('a client with nobody to take an upgrade closes the connection', async (t) => {
  const server = await listen(http.createServer())

  server.on('upgrade', (req, socket) =>
    socket.end(
      'HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
        'Upgrade: weird-protocol\r\n' +
        'Connection: Upgrade\r\n' +
        '\r\n'
    )
  )

  const req = http
    .request({
      port: server.address().port,
      headers: { Connection: 'Upgrade', Upgrade: 'weird-protocol' }
    })
    .end()

  await waitFor(req, 'close')

  t.pass('connection closed')

  await closeServer(server)
})

// The switch happens once the message asking for it is complete, so a body it
// announced is still the request's own. Handing that over as the first bytes of
// the new protocol both loses it and lets the peer choose what they are.
test('an upgrade takes effect only once the request is complete', async (t) => {
  const server = await listen(http.createServer())

  const handed = new Promise((resolve) => {
    server.on('upgrade', (req, socket, head) => {
      const chunks = []

      req
        .on('data', (data) => chunks.push(data))
        .on('end', () => resolve({ body: Buffer.concat(chunks), head }))

      socket.end()
    })
  })

  await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade\r\n' +
      'Content-Length: 5\r\n' +
      '\r\n' +
      'hello' +
      'first frame'
  )

  const { body, head } = await handed

  t.alike(body, Buffer.from('hello'), 'the announced body belongs to the request')
  t.alike(head, Buffer.from('first frame'), 'and only what follows it is handed over')

  await closeServer(server)
})

test('an upgrade with a chunked body takes effect once the body is decoded', async (t) => {
  const server = await listen(http.createServer())

  const handed = new Promise((resolve) => {
    server.on('upgrade', (req, socket, head) => {
      const chunks = []

      req
        .on('data', (data) => chunks.push(data))
        .on('end', () => resolve({ body: Buffer.concat(chunks), head }))

      socket.end()
    })
  })

  await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade\r\n' +
      'Transfer-Encoding: chunked\r\n' +
      '\r\n' +
      '5\r\nhello\r\n0\r\n\r\n' +
      'first frame'
  )

  const { body, head } = await handed

  t.alike(body, Buffer.from('hello'), 'the body is decoded for the request')
  t.alike(head, Buffer.from('first frame'), 'and the coding does not reach the handover')

  await closeServer(server)
})

// Nothing reads the body until the handover, so nothing pushes back on it and a
// peer that could name its own size would have an unbounded sink here.
test('an upgrade body larger than the limit is refused before it is read', async (t) => {
  const server = await listen(http.createServer({ maxUpgradeBodySize: 1024 }))

  server.on('upgrade', () => t.fail('the handover must not happen'))

  const closed = new Promise((resolve) =>
    server.on('connection', (socket) => socket.on('close', resolve))
  )

  const peer = rawIdle(
    server.address().port,
    'POST / HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade\r\n' +
      'Content-Length: 4096\r\n' +
      '\r\n'
  )

  await waitFor(peer.socket, 'end')

  t.ok(peer.response.startsWith('HTTP/1.1 413 Payload Too Large\r\n'), 'answered 413')

  await closed

  t.is(server.connections.size, 0, 'taken down without waiting on the peer')

  peer.socket.destroy()

  await closeServer(server)
})

// A chunked body announces no size, so the limit has to hold as it arrives.
test('a chunked upgrade body is cut off once it passes the limit', async (t) => {
  const server = await listen(http.createServer({ maxUpgradeBodySize: 1024 }))

  server.on('upgrade', () => t.fail('the handover must not happen'))

  const failed = new Promise((resolve) => server.on('clientError', resolve))

  const chunk = 'a'.repeat(512)

  const peer = rawIdle(
    server.address().port,
    'POST / HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade\r\n' +
      'Transfer-Encoding: chunked\r\n' +
      '\r\n' +
      ('200\r\n' + chunk + '\r\n').repeat(8)
  )

  t.is((await failed).code, 'BODY_TOO_LARGE', 'the body was cut off')

  peer.socket.destroy()

  await closeServer(server)
})

test('an upgrade body within the limit is still handed to the request', async (t) => {
  const server = await listen(http.createServer({ maxUpgradeBodySize: 1024 }))

  const handed = new Promise((resolve) => {
    server.on('upgrade', (req, socket, head) => {
      const chunks = []

      req.on('data', (data) => chunks.push(data)).on('end', () => resolve(Buffer.concat(chunks)))

      socket.end()
    })
  })

  await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade\r\n' +
      'Content-Length: 5\r\n' +
      '\r\n' +
      'hello'
  )

  t.alike(await handed, Buffer.from('hello'), 'the body was held for the request')

  await closeServer(server)
})

test('an upgrade body limit of zero holds nothing back', async (t) => {
  const server = await listen(http.createServer({ maxUpgradeBodySize: 0 }))

  const handed = new Promise((resolve) => {
    server.on('upgrade', (req, socket, head) => {
      const chunks = []

      req.on('data', (data) => chunks.push(data)).on('end', () => resolve(Buffer.concat(chunks)))

      socket.end()
    })
  })

  const body = 'a'.repeat(100000)

  await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade\r\n' +
      `Content-Length: ${body.length}\r\n` +
      '\r\n' +
      body
  )

  t.is((await handed).byteLength, body.length, 'the whole body was held')

  await closeServer(server)
})

// An upgrade is a request as well as an offer, so one nobody took is still
// answerable, and Node.js answers it. A tunnel has no such fallback: no response
// would make sense of a `CONNECT`.
test('an upgrade nobody is there to take is served as an ordinary request', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end('ordinary')))

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade, close\r\n' +
      '\r\n'
  )

  t.ok(raw.startsWith('HTTP/1.1 200 OK'), 'answered as a request')
  t.ok(raw.endsWith('ordinary'), 'by the request handler')

  await closeServer(server)
})

test('a tunnel nobody is there to take takes the connection down', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end('ordinary')))

  const raw = await rawBytes(
    server.address().port,
    'CONNECT localhost:443 HTTP/1.1\r\nHost: localhost\r\n\r\n'
  )

  t.is(raw.length, 0, 'nothing was answered')

  await closeServer(server)
})

test('expect 100-continue is answered automatically', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    http.createServer((req, res) => {
      const chunks = []

      req
        .on('data', (data) => chunks.push(data))
        .on('end', () => {
          sub.alike(Buffer.concat(chunks), Buffer.from('hello'), 'body received')

          res.end('done')
        })
    })
  )

  // A client that asks whether to send its body will not send it until it has
  // been told, so an unanswered expectation deadlocks the exchange.
  const raw = await rawRequest(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n' +
      'Expect: 100-continue\r\nContent-Length: 5\r\n\r\n',
    { on: '100 Continue', send: 'hello' }
  )

  await sub

  t.ok(raw.startsWith('HTTP/1.1 100 Continue\r\n\r\n'), 'continue sent first')
  t.ok(raw.endsWith('\r\n\r\ndone'), 'response follows')

  await closeServer(server)
})

test('expect 100-continue is answered by a checkContinue handler', async (t) => {
  const server = http.createServer()

  // A handler takes the decision over, and may turn the request down before its
  // body is ever sent.
  server.on('checkContinue', (req, res) => {
    res.statusCode = 417
    res.end('nope')
  })

  await listen(server)

  const raw = await rawRequest(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n' +
      'Expect: 100-continue\r\nContent-Length: 5\r\n\r\n'
  )

  t.absent(raw.includes('100 Continue'), 'continue not sent')
  t.ok(raw.startsWith('HTTP/1.1 417 Expectation Failed\r\n'), 'request turned down')

  await closeServer(server)
})

test('interim response is reported separately from the response', async (t) => {
  const sub = t.test()
  sub.plan(3)

  // An interim 1xx is not the answer to the request: the real response follows,
  // and the request has to stay open for it.
  const server = await rawServer(
    'HTTP/1.1 103 Early Hints\r\nLink: </style.css>\r\n\r\n' +
      'HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nresponse'
  )

  const agent = new http.Agent({ port: server.address().port })

  const req = http.request({ agent }, (res) => {
    sub.is(res.statusCode, 200, 'final status')

    res.on('data', (data) => sub.alike(data, Buffer.from('response'), 'body received'))
  })

  req.on('information', (info) => sub.is(info.statusCode, 103, 'interim status'))

  req.end()

  await sub

  agent.destroy()

  await closeServer(server)
})

test('GET request', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      t.is(req.url, '/path')
      t.is(req.method, 'GET')

      res.end('response')
    })
  )

  const url = `http://localhost:${server.address().port}/path`

  // Both of the forms a URL may be given in.
  for (const target of [url, new URL(url)]) {
    const body = await new Promise((resolve) => {
      http.get(target, (res) => {
        const chunks = []

        res.on('data', (data) => chunks.push(data)).on('end', () => resolve(Buffer.concat(chunks)))
      })
    })

    t.alike(body, Buffer.from('response'), 'response received')
  }

  await closeServer(server)
})

test('custom request headers', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    http.createServer((req, res) => {
      sub.is(req.headers['custom-header'], 'value')

      res.end()
    })
  )

  await request({ port: server.address().port, headers: { 'custom-header': 'value' } })

  await sub

  await closeServer(server)
})

test('client request timeout', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await listen(
    http.createServer(async (req, res) => {
      await sub

      res.end()
    })
  )

  const since = Date.now()

  const req = http.request({ port: server.address().port }, (res) => res.resume()).end()

  req.on('timeout', () => sub.pass('timeout')).setTimeout(100, () => sub.pass('callback invoked'))

  await sub

  // The deadline that ran has to be the one that was asked for. Settling for any
  // timeout at all would be met just as well by the agent's own, which is
  // measured in seconds, and would say nothing about whether the one set here
  // ever took hold.
  t.ok(Date.now() - since < 1000, 'the deadline that ran was the one that was set')

  await waitFor(req, 'close')

  await closeServer(server)
})

test('the server timeout is reported', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = http.createServer((req, res) => res.end())

  server
    .on('timeout', () => sub.pass('timeout'))
    .setTimeout(100, () => sub.pass('callback invoked'))

  await listen(server)

  // Connected but silent, so it is the socket timeout that fires rather than one
  // of the request deadlines.
  const socket = tcp.createConnection(server.address().port, 'localhost')

  socket.on('error', () => {})

  await sub

  socket.destroy()

  await closeServer(server)
})

test('a server timeout nobody handles takes the connection down', async (t) => {
  const server = await listen(http.createServer().setTimeout(100))

  // Driven with a bare socket, since what is being tested is what the server
  // does with a connection nobody is listening for, not what a client makes of
  // it: going through one would put the agent, its pool and a whole state
  // machine between the timeout and the only thing that ends the test.
  const socket = tcp.createConnection(server.address().port, 'localhost')

  // Whichever way the connection goes away counts, and a half open socket is
  // only ever read closed here, as this side never writes and so never ends.
  await new Promise((resolve) => {
    socket.on('error', resolve).on('end', resolve).on('close', resolve)
  })

  t.pass('the connection was taken down')

  socket.destroy()

  await closeServer(server)
})

test('the server timeout reaches the response', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    http
      .createServer((req, res) => {
        res.on('timeout', () => {
          sub.pass('response timeout')

          res.end()
        })
      })
      .setTimeout(100)
  )

  const req = http.request({ port: server.address().port }).end()

  await sub
  await waitFor(req, 'close')

  await closeServer(server)
})

test('a response deadline is reported', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await listen(
    http.createServer(async (req, res) => {
      res
        .on('timeout', () => sub.pass('timeout'))
        .setTimeout(100, () => sub.pass('callback invoked'))

      await sub

      res.end()
    })
  )

  const req = http.request({ port: server.address().port }).end()

  await sub
  await waitFor(req, 'close')

  await closeServer(server)
})

test('the deadlines are cancelled once the connection has been upgraded', async (t) => {
  const server = http.createServer()

  server
    .on('upgrade', (req, socket) =>
      socket.write(
        'HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
          'Upgrade: weird-protocol\r\n' +
          'Connection: Upgrade\r\n' +
          '\r\n'
      )
    )
    .on('timeout', () => t.fail('server timeout'))
    .setTimeout(100, () => t.fail('server callback invoked'))

  await listen(server)

  const req = http.request({
    port: server.address().port,
    headers: { Connection: 'Upgrade', Upgrade: 'weird-protocol' }
  })

  req
    .on('error', () => {})
    .on('timeout', () => t.fail('client timeout'))
    .setTimeout(100, () => t.fail('client callback invoked'))

  const handed = new Promise((resolve) => req.on('upgrade', (res, socket) => resolve(socket)))

  req.end()

  const socket = await handed

  // Well past both deadlines, neither of which is the connection's any more.
  await pause(400)

  t.pass('the deadlines were cancelled')

  socket.destroy()

  await closeServer(server)
})

test('socket reuse', async (t) => {
  const sub = t.test()
  sub.plan(3)

  const server = await listen(http.createServer((req, res) => res.end('response')))

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  let socket

  let req = http
    .request({ agent }, (res) => {
      socket = req.socket

      res.on('data', (data) => sub.alike(data, Buffer.from('response')))
    })
    .on('close', () =>
      setImmediate(() => {
        req = http
          .request({ agent }, (res) => {
            sub.is(req.socket, socket, 'socket reused')

            res.on('data', (data) => sub.alike(data, Buffer.from('response')))
          })
          .on('close', () => agent.destroy())
          .end()
      })
    )
    .end()

  await sub

  await closeServer(server)
})

test('socket reuse, destroy first response', async (t) => {
  const sub = t.test()
  sub.plan(3)

  const server = await listen(http.createServer((req, res) => res.end('response')))

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  let socket

  let req = http
    .request({ agent }, (res) => {
      socket = req.socket

      res.on('close', () => sub.pass('response closed')).destroy()
    })
    .on('close', () =>
      setImmediate(() => {
        req = http
          .request({ agent }, (res) => {
            sub.not(req.socket, socket, 'socket not reused')

            res.on('data', (data) => sub.alike(data, Buffer.from('response')))
          })
          .on('close', () => agent.destroy())
          .end()
      })
    )
    .end()

  await sub

  await closeServer(server)
})

test('socket reuse, destroy pooled socket', async (t) => {
  t.plan(2)

  const server = await listen(http.createServer((req, res) => res.end('response')))

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const first = http.request({ agent }, (res) => res.resume())

  const socket = first.socket

  first.end()

  await waitFor(first, 'close')

  // Destroyed and replaced within the same tick, so the socket has not had a
  // chance to close and is still there to be picked up.
  socket.destroy()

  const sub = t.test('second request')
  sub.plan(1)

  const second = http.request({ agent }, (res) => {
    res.on('data', (data) => sub.alike(data, Buffer.from('response')))
  })

  // Asserted before awaiting the response, as reusing the socket leaves the
  // second request without one.
  t.not(second.socket, socket, 'socket not reused')

  second.on('close', () => agent.destroy()).end()

  await sub

  await closeServer(server)
})

test('socket reuse, server closes the connection', async (t) => {
  t.plan(2)

  const server = await listen(
    http.createServer((req, res) => {
      // The peer is bowing out, so its socket must not be picked up for the next
      // request however keen the agent is to keep it.
      res.setHeader('Connection', 'close')
      res.end('response')
    })
  )

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const first = http.request({ agent }, (res) => res.resume())

  const socket = first.socket

  first.end()

  await waitFor(first, 'close')

  const sub = t.test('second request')
  sub.plan(1)

  const second = http.request({ agent }, (res) => {
    res.on('data', (data) => sub.alike(data, Buffer.from('response')))
  })

  t.not(second.socket, socket, 'socket not reused')

  second.on('close', () => agent.destroy()).end()

  await sub

  await closeServer(server)
})

test('socket reuse, socket closes after timeout', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await listen(http.createServer((req, res) => res.end('response')))

  const agent = new http.Agent({
    port: server.address().port,
    keepAlive: true,
    timeout: 500
  })

  const req = http
    .request({ agent }, (res) => {
      res.on('close', () => sub.pass('response closed')).resume()

      req.socket.on('close', () => sub.pass('socket closed'))
    })
    .end()

  await sub

  await closeServer(server)
})

test('close server while a response is in flight', async (t) => {
  t.plan(4)

  const server = http.createServer((req, res) => {
    // Closed from inside the handler, which must not cut short the response the
    // handler is about to write.
    server.close(() => t.pass('server closed'))

    setTimeout(() => res.end('late response'), 100)
  })

  await listen(server)

  const agent = new http.Agent({ port: server.address().port })

  const result = await request({ agent })

  t.is(result.error, null, 'no error')
  t.is(result.response.statusCode, 200, 'response received')
  t.alike(Buffer.concat(result.response.chunks), Buffer.from('late response'), 'body intact')

  agent.destroy()
})

test('close server while a response is in flight, closed from outside', async (t) => {
  t.plan(4)

  const server = await listen(
    http.createServer((req, res) => setTimeout(() => res.end('late response'), 200))
  )

  const agent = new http.Agent({ port: server.address().port })

  const result = request({ agent })

  // The usual shutdown: close while requests are still being served.
  setTimeout(() => server.close(() => t.pass('server closed')), 50)

  const { error, response } = await result

  t.is(error, null, 'no error')
  t.is(response.statusCode, 200, 'response received')
  t.alike(Buffer.concat(response.chunks), Buffer.from('late response'), 'body intact')

  agent.destroy()
})

test('close server with a request that is never answered', async (t) => {
  const sub = t.test()
  sub.plan(1)

  // Taken but never answered, so the exchange never finishes on its own.
  const server = await listen(http.createServer(() => sub.pass('request received')))

  const agent = new http.Agent({ port: server.address().port })

  http
    .request({ agent })
    .on('error', () => {})
    .end()

  await sub

  let closed = false

  const done = new Promise((resolve) =>
    server.close(() => {
      closed = true

      resolve()
    })
  )

  await pause(50)

  t.absent(closed, 'close waits for the exchange to finish')

  // An exchange in flight is not idle, so this leaves it alone.
  server.closeIdleConnections()

  await pause(50)

  t.absent(closed, 'idle connections only')

  // It will never finish, so the connection has to be taken down by hand.
  server.closeAllConnections()

  await done

  agent.destroy()
})

test('close server with an idle keep-alive connection', async (t) => {
  t.plan(2)

  const server = await listen(http.createServer((req, res) => res.end('response')))

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const result = await request({ agent })

  t.is(result.response.statusCode, 200, 'response received')

  // Nothing is in flight any more, so closing must not wait on the pooled
  // connection.
  server.close(() => t.pass('close did not hang on the pooled connection'))

  agent.destroy()
})

test('reuse port after closing server', async (t) => {
  const first = await listen(http.createServer((req, res) => res.end()))

  const { port } = first.address()

  await request({ port })
  await closeServer(first)

  const second = await listen(
    http.createServer((req, res) => res.end()),
    port
  )

  const { response } = await request({ port })

  t.is(response.statusCode, 200, 'the port was free to be taken again')

  await closeServer(second)
})

test('socket closes when the agent does not keep it alive', async (t) => {
  t.plan(3)

  // A raw server, as it must leave its own side of the connection open when the
  // client half-closes.
  const server = await rawServer('HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nresponse')

  const agent = new http.Agent({ port: server.address().port, keepAlive: false })

  const req = http.request({ agent }, (res) => res.resume())

  const closed = waitFor(req.socket, 'close')

  req.end()

  await closed

  t.pass('socket closed')
  t.is([...agent.sockets].length, 0, 'no sockets left')
  t.is([...agent.freeSockets].length, 0, 'no free sockets left')

  await closeServer(server)
})

test('socket closes when the peer half-closes it', async (t) => {
  t.plan(3)

  const server = await rawServer('HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nresponse', {
    end: true
  })

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  // The response is deliberately left unconsumed, so the socket is still in use
  // by the time the peer half-closes it.
  const req = http.request({ agent })

  const closed = waitFor(req.socket, 'close')

  req.end()

  await closed

  t.pass('socket closed')
  t.is([...agent.sockets].length, 0, 'no sockets left')
  t.is([...agent.freeSockets].length, 0, 'no free sockets left')

  await closeServer(server)
})

// A socket is either one the agent is using or one waiting in its pool, never
// both and never counted twice, however many exchanges it goes on to carry.
test('a reused socket is only ever tracked in one place', async (t) => {
  t.plan(15)

  const server = await listen(http.createServer((req, res) => res.end('response')))

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  let socket = null

  for (let i = 0; i < 3; i++) {
    const responded = new Promise((resolve) => {
      const req = http.request({ agent }, (res) => res.on('close', resolve).resume())

      if (socket === null) socket = req.socket
      else t.is(req.socket, socket, 'socket reused')

      t.is([...agent.sockets].length, 1, 'in use while the exchange is on')
      t.is([...agent.freeSockets].length, 0, 'and not in the pool as well')

      req.end()
    })

    await responded

    t.is([...agent.sockets].length, 0, 'no longer in use once it has been answered')
    t.is([...agent.freeSockets].length, 1, 'and in the pool exactly once')
  }

  const closed = waitFor(socket, 'close')

  // Pooled rather than in use, so this also says a pooled one is not left behind.
  agent.destroy()

  await closed

  t.is([...agent.freeSockets].length, 0, 'the pooled socket was taken down')

  await closeServer(server)
})

// An agent that may only hold so many sockets cannot open one for every request
// at once, so the ones it has no room for wait for one to come free rather than
// opening more than the caller allowed for.
test('an agent opens no more sockets at once than it may hold', async (t) => {
  let open = 0
  let peak = 0

  const server = await listen(
    http.createServer((req, res) => {
      const chunks = []

      req
        .on('data', (data) => chunks.push(data))
        .on('end', async () => {
          await pause(50)

          res.end(Buffer.concat(chunks))
        })
    })
  )

  server.on('connection', (socket) => {
    peak = Math.max(peak, ++open)

    socket.on('close', () => open--)
  })

  const agent = new http.Agent({ port: server.address().port, keepAlive: true, maxSockets: 1 })

  const bodies = ['first', 'second', 'third']

  const answered = await Promise.all(
    bodies.map((body) =>
      request({ agent, method: 'POST' }, (client) => client.end(body)).then(({ response }) =>
        Buffer.concat(response.chunks).toString()
      )
    )
  )

  t.is(peak, 1, 'only ever one socket at a time')

  // Written before the agent had a socket to write it onto, so this also says
  // that a body given to a request that has to wait is not lost.
  t.alike(answered, bodies, 'and every request was answered in turn')

  agent.destroy()

  await closeServer(server)
})

test('an agent keeps no more sockets in its pool than it may hold', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end('ok')))

  const agent = new http.Agent({ port: server.address().port, keepAlive: true, maxFreeSockets: 1 })

  await Promise.all([request({ agent }), request({ agent }), request({ agent })])

  t.is([...agent.sockets].length, 0, 'none left in use')
  t.is([...agent.freeSockets].length, 1, 'and only the one kept')

  agent.destroy()

  await closeServer(server)
})

// The total is held across every origin the agent talks to, so the one that
// gives a socket up has to be able to give it to a request waiting on another.
// Pooling it instead would leave that request waiting for as long as the pool
// held on to it, which is to say forever.
test('an agent holds its total across the origins it talks to', async (t) => {
  const first = await listen(http.createServer((req, res) => res.end('first')))
  const second = await listen(http.createServer((req, res) => res.end('second')))

  const agent = new http.Agent({ keepAlive: true, maxTotalSockets: 1 })

  const answered = await within(
    5000,
    Promise.all(
      [first, second].map((server) =>
        request({ agent, port: server.address().port }).then(({ response }) =>
          Buffer.concat(response.chunks).toString()
        )
      )
    )
  )

  t.alike(answered, ['first', 'second'], 'both origins were reached')

  agent.destroy()

  await closeServer(first)
  await closeServer(second)
})

test('a request given up on while it waits for a socket is owed nothing', async (t) => {
  const server = await listen(
    http.createServer(async (req, res) => {
      await pause(50)

      res.end('ok')
    })
  )

  const agent = new http.Agent({ port: server.address().port, keepAlive: true, maxSockets: 1 })

  const answered = request({ agent })

  const waiting = http.request({ agent })

  t.is(waiting.socket, null, 'the second request has no socket to write onto')

  const closed = waitFor(waiting, 'close')

  waiting.on('error', (err) => t.is(err.code, 'CONNECTION_LOST', 'the waiting request was cut off'))

  waiting.end()
  waiting.destroy(http.errors.CONNECTION_LOST())

  await closed

  const { response } = await answered

  t.alike(Buffer.concat(response.chunks), Buffer.from('ok'), 'the one that had a socket went on')

  agent.destroy()

  await closeServer(server)
})

test('a request waiting for a socket is told when the agent is suspended', async (t) => {
  const server = await listen(
    http.createServer(async (req, res) => {
      await pause(50)

      res.end('ok')
    })
  )

  const agent = new http.Agent({ port: server.address().port, keepAlive: true, maxSockets: 1 })

  const answered = request({ agent })
  const waiting = request({ agent })

  await pause(10)

  agent.suspend()

  t.is((await waiting).error.code, 'AGENT_SUSPENDED', 'the waiting request was told')
  t.ok((await answered).error, 'and the one in flight was cut off with its socket')

  await closeServer(server)
})

// Nothing else is going to come free on a connection that has gone, so a request
// waiting behind it has a socket opened for it rather than waiting on one that
// is never handed back.
test('a socket lost under a request opens another for the one behind it', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      if (req.url === '/lost') return res.socket.destroy()

      res.end('ok')
    })
  )

  const agent = new http.Agent({ port: server.address().port, keepAlive: true, maxSockets: 1 })

  const lost = request({ agent, path: '/lost' })
  const behind = request({ agent, path: '/behind' })

  t.ok((await lost).error, 'the request whose socket went was reported')

  const { response } = await within(5000, behind)

  t.alike(Buffer.concat(response.chunks), Buffer.from('ok'), 'and the one behind it was served')

  agent.destroy()

  await closeServer(server)
})

// The timeout belongs to the socket, which a request that is waiting has not
// been handed yet, so it is kept until there is one to set it on.
test('a timeout set while a request waits for a socket still takes', async (t) => {
  const server = await listen(
    http.createServer(async (req, res) => {
      await pause(150)

      res.end('ok')
    })
  )

  const agent = new http.Agent({ port: server.address().port, keepAlive: true, maxSockets: 1 })

  const answered = request({ agent })

  const waiting = http.request({ agent })

  const timedOut = waitFor(waiting, 'timeout')

  waiting.setTimeout(30)
  waiting.on('error', () => {}).on('response', (res) => res.resume())
  waiting.end()

  t.ok(
    await within(
      5000,
      timedOut.then(() => true)
    ),
    'the timeout reached the socket it waited on'
  )

  waiting.destroy()

  await answered

  agent.destroy()

  await closeServer(server)
})

test('an agent holds what Node.js holds by default', (t) => {
  const agent = new http.Agent()

  t.is(agent.maxSockets, Infinity, 'as many sockets at once as are asked for')
  t.is(agent.maxFreeSockets, 256, 'and only so many kept in the pool')
  t.is(agent.maxTotalSockets, Infinity, 'with no total of its own')
})

test('suspend agent', async (t) => {
  t.plan(6)

  const sub = t.test()
  sub.plan(2)

  const server = await listen(http.createServer((req, res) => res.end()))

  const agent = new http.Agent({ port: server.address().port })

  const req = http.request({ agent }).end()

  // Suspending takes the connection out from under a request that was never
  // answered, which the request is told about.
  req.on('error', (err) => sub.is(err.code, 'CONNECTION_LOST', 'request failed'))
  req.socket.on('close', () => sub.pass('socket closed'))

  agent.suspend()

  t.is(agent.suspended, true)
  t.execution(agent.resumed)

  await sub

  await t.exception(() => http.request({ agent }), /AGENT_SUSPENDED/)

  agent.resume()

  t.is(agent.suspended, false)
  t.absent(agent.resumed)

  await request({ agent })

  agent.destroy()

  await closeServer(server)
})

test('a status code must be a status code', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  // A status code is written straight into the status line, so a string could
  // otherwise carry a whole response of its own.
  for (const code of ['200 OK\r\nX-Injected: yes', 99, 1000, 200.5]) {
    t.exception(
      () => {
        res.statusCode = code
      },
      /INVALID_STATUS_CODE/,
      `refused ${JSON.stringify(code)}`
    )

    t.exception(
      () => res.writeHead(code),
      /INVALID_STATUS_CODE/,
      `refused by writeHead ${JSON.stringify(code)}`
    )
  }

  t.is(res.writeHead(200), res, 'chainable, as in Node.js')
})

test('a status message must be a field value', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  t.exception(() => {
    res.statusMessage = 'OK\r\nInjected-Header: pwned'
  }, /INVALID_HEADER_VALUE/)

  t.exception(() => res.writeHead(200, 'OK\r\nInjected: x'), /INVALID_HEADER_VALUE/)
})

test('a header name must be a token', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  t.exception(() => res.setHeader('bad header', 'value'), /INVALID_HEADER_NAME/)
  t.exception(() => res.setHeader(1, 'x'), /INVALID_HEADER_NAME/)
  t.exception(() => res.setHeader(null, 'x'), /INVALID_HEADER_NAME/)
  t.exception(() => res.getHeader(1), /INVALID_HEADER_NAME/)
  t.exception(() => res.hasHeader(null), /INVALID_HEADER_NAME/)

  t.exception(() => res.setHeader('__proto__', { 'content-length': '999' }), /INVALID_HEADER_NAME/)
  t.exception(() => res.setHeader('__PROTO__', 'x'), /INVALID_HEADER_NAME/)

  // The framing decision reads the header bag, so a bag whose prototype had
  // been replaced would leave the response unframed altogether.
  t.absent(res.hasHeader('content-length'), 'nothing was stored')
})

test('a header value must be a field value', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  // Control characters, and anything above Latin-1, which has no single byte to
  // stand for it on the line.
  for (const c of ['\x00', '\x01', '\x0b', '\x0c', '\r', '\n', '\x7f', '\u2028']) {
    t.exception(
      () => res.setHeader('x-thing', 'a' + c + 'b'),
      /INVALID_HEADER_VALUE/,
      `refused ${JSON.stringify(c)}`
    )
  }

  t.exception(
    () => res.writeHead(200, { 'x-evil': 'value\r\nInjected: x' }),
    /INVALID_HEADER_VALUE/
  )

  t.exception(
    () => res.writeHead(200, ['x-a', '1', 'x-b']),
    /INVALID_HEADER_VALUE/,
    'a name with no value'
  )

  // Serializing it would put the string `undefined` on the wire as though the
  // caller had meant it.
  t.exception(() => res.setHeader('x-thing', undefined), /INVALID_HEADER_VALUE/)
  t.exception(() => res.setHeader('x-thing', ['a', undefined]), /INVALID_HEADER_VALUE/)
  t.exception(() => {
    res.headers = { 'x-thing': undefined }
  }, /INVALID_HEADER_VALUE/)

  // A null value is a deliberate one, and Latin-1 remains allowed, as both are
  // in Node.js.
  t.execution(() => res.setHeader('x-null', null))
  t.execution(() => res.setHeader('x-thing', 'caf\xe9'))
})

test('control characters in a request path are refused', (t) => {
  // Along with anything above Latin-1, which has no single byte to stand for it.
  for (const c of ['\x00', '\x01', '\r', '\n', ' ', '\t', '\u0100']) {
    t.exception(
      () => new http.ClientRequest({ path: '/a' + c, agent: false }),
      /INVALID_HEADER_VALUE/,
      `refused ${JSON.stringify(c)}`
    )
  }
})

test('a client request refuses anything that would smuggle a request line', (t) => {
  t.exception(
    () =>
      new http.ClientRequest({
        agent: false,
        headers: { 'x-evil': 'value\r\nInjected-Header: pwned' }
      }),
    /INVALID_HEADER_VALUE/
  )

  t.exception(
    () => new http.ClientRequest({ agent: false, method: 'GET\r\nEvil' }),
    /INVALID_HEADER_NAME/
  )
})

test('a host that is not a string is refused', (t) => {
  t.exception(() => http.request({ host: 1234, port: 80 }), /INVALID_HEADER_VALUE/)
  t.exception(() => new http.ClientRequest({ host: {}, port: 80 }), /INVALID_HEADER_VALUE/)
})

test('unknown status code gets a placeholder reason phrase', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.statusCode = 599
      res.end()
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.startsWith('HTTP/1.1 599 unknown\r\n'), 'reason phrase filled in')

  await closeServer(server)
})

test('malformed request is reported as a client error', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = http.createServer((req, res) => res.end())

  // A handler takes the error on, so the server does not answer it itself.
  server.on('clientError', (err, socket) => {
    sub.ok(err.code, 'client error reported')

    socket.destroy()
  })

  await listen(server)

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nBad Header: value\r\n\r\n'
  )

  await sub

  t.is(raw, '', 'handler answered it instead')

  await closeServer(server)
})

test('request truncated by the peer', async (t) => {
  const sub = t.test()
  sub.plan(3)

  const server = http.createServer((req) => {
    req
      .on('end', () => sub.fail('the body never completed'))
      // Closed without an error, so that a client dropping a connection cannot
      // take the server down with it, and marked short so that the consumer can
      // still tell what happened.
      .on('close', () => {
        sub.absent(req.complete, 'request stopped short')
        sub.pass('request closed')
      })
      .resume()
  })

  server.on('clientError', (err) => sub.ok(err, 'client error reported'))

  await listen(server)

  const socket = tcp.createConnection(server.address().port, 'localhost')

  socket.on('error', () => {})

  // Promises ten bytes, sends four, then stops writing.
  socket.write(Buffer.from('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nabcd'))
  socket.end()

  await sub

  socket.destroy()

  await closeServer(server)
})

test('peer stops writing after a complete request', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = http.createServer((req, res) => {
    req.on('end', () => sub.pass('request completed')).resume()

    res.end('response')
  })

  // Half-closing after a whole request is not a truncation.
  server.on('clientError', () => t.fail('no client error expected'))

  await listen(server)

  const socket = tcp.createConnection(server.address().port, 'localhost')

  socket.on('error', () => {})
  socket.end(Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'))

  await sub

  socket.destroy()

  await closeServer(server)
})

test('setTimeout after the message has ended', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    http.createServer((req, res) => {
      req.resume().on('end', () => {
        // The message has let go of its socket by now, which is no reason to
        // throw at the caller.
        sub.execution(() => req.setTimeout(1000), 'setTimeout does not throw')

        res.end()
      })
    })
  )

  const agent = new http.Agent({ port: server.address().port })

  const result = await request({ agent, method: 'POST' }, (client) => client.end('body'))

  await sub

  t.is(result.response.statusCode, 200, 'response received')

  agent.destroy()

  await closeServer(server)
})

test('response carries a date, which can be replaced', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      if (req.url === '/own') res.setHeader('Date', 'whenever')

      res.end()
    })
  )

  const { port } = server.address()

  const raw = await rawRequest(
    port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(/^date: .+ GMT\r$/im.test(raw), 'date sent')

  const own = await rawRequest(
    port,
    'GET /own HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.is(own.match(/^date:/gim).length, 1, 'date sent once')

  await closeServer(server)
})

// A body that does not match what the peer was told to read runs over into the
// next message on the connection, so it never reaches the socket at all. The
// consumer has no reason to listen for an error on a response it only writes to,
// so the server is told as well.
test('a response body that does not match its content length is not sent', async (t) => {
  const bodies = {
    '/long': ['2', 'hello world'],
    '/short': ['20', 'short'],
    // `String#length` counts characters, which is the easiest mismatch to write
    // by accident: six characters, nine bytes.
    '/characters': ['6', 'café ❤']
  }

  const reported = []

  const server = await listen(
    http.createServer((req, res) => {
      const [length, body] = bodies[req.url]

      res.on('error', (err) => reported.push(req.url + ':' + err.code))

      res.setHeader('Content-Length', length)
      res.end(body)
    })
  )

  server.on('clientError', (err) => reported.push('server:' + err.code))

  for (const path of Object.keys(bodies)) {
    const raw = await rawBytes(
      server.address().port,
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
    )

    t.is(raw, '', `nothing sent for ${path}`)
  }

  await pause(100)

  t.is(
    reported.filter((code) => code.endsWith(':CONTENT_LENGTH_MISMATCH')).length,
    6,
    'each failure was reported on its response and to the server'
  )

  await closeServer(server)
})

// A content length the peer would read as a different number, or not as a
// number at all, leaves the body unframed.
test('a content length that is not a count of bytes is refused', async (t) => {
  const lengths = { '/trailing': '2 ', '/words': 'not-a-length' }

  const reported = []

  const server = await listen(
    http.createServer((req, res) => {
      res.on('error', (err) => reported.push(req.url + ':' + err.code))

      res.setHeader('Content-Length', lengths[req.url])
      res.end('hi')
    })
  )

  server.on('clientError', (err) => reported.push('server:' + err.code))

  for (const path of Object.keys(lengths)) {
    const raw = await rawBytes(
      server.address().port,
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
    )

    t.is(raw, '', `nothing sent for ${path}`)
  }

  await pause(100)

  t.is(
    reported.filter((code) => code.endsWith(':INVALID_CONTENT_LENGTH')).length,
    4,
    'each failure was reported on its response and to the server'
  )

  await closeServer(server)
})

// A body written in more than one go is only known to be too long once part of
// it is already out, so the connection goes rather than the surplus.
test('a response body longer than its content length is cut off mid stream', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    http.createServer((req, res) => {
      res.on('error', (err) =>
        sub.is(err.code, 'CONTENT_LENGTH_MISMATCH', 'reported on the response')
      )

      res.setHeader('Content-Length', '6')
      res.write('first ')
      res.write('SURPLUS')
      res.end()
    })
  )

  const raw = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.absent(raw.includes('SURPLUS'), 'surplus never reaches the peer')

  await closeServer(server)
})

test('a 304 content length that is not a count of bytes is refused', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    http.createServer((req, res) => {
      res.on('error', (err) =>
        sub.is(err.code, 'INVALID_CONTENT_LENGTH', 'reported on the response')
      )

      res.statusCode = 304
      res.setHeader('Content-Length', 'lots')
      res.end()
    })
  )

  const raw = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.is(raw, '', 'nothing sent')

  await closeServer(server)
})

// A zero length chunk is what terminates a chunked body, so writing one before
// the end would finish the response early and turn the rest into a second one.
test('zero length write does not terminate a chunked body', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.write('aaa')
      res.write(Buffer.alloc(0))
      res.write('')
      res.end('bbb')
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.includes('Transfer-Encoding: chunked\r\n'), 'chunked')
  t.ok(raw.endsWith('\r\n\r\n3\r\naaa\r\n3\r\nbbb\r\n0\r\n\r\n'), 'one body, terminated once')

  await closeServer(server)
})

test('zero length write does not split a response in two', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      if (req.url === '/first') {
        res.write('aa')
        res.write(Buffer.alloc(0))
        res.end('bb')
      } else {
        res.end('second')
      }
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n' +
      'GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.is(raw.split('HTTP/1.1 200 OK').length - 1, 2, 'one response each')
  t.ok(raw.includes('2\r\naa\r\n2\r\nbb\r\n0\r\n\r\nHTTP/1.1 200 OK'), 'bodies not split')

  await closeServer(server)
})

// A peer reads no body for these, so anything written for one would be read as
// the start of the next response.
test('status that carries no body is sent without one', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.statusCode = Number(req.url.slice(1))
      res.end('injected')
    })
  )

  for (const status of [204, 304, 100]) {
    const raw = await rawRequest(
      server.address().port,
      `GET /${status} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
    )

    t.is(
      raw,
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n` +
        raw.slice(raw.indexOf('Date: ')),
      `${status} carries neither a body nor a length`
    )
  }

  await closeServer(server)
})

test('status that carries no body does not split a response in two', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      if (req.url === '/first') {
        res.statusCode = 204
        res.end('INJECTED')
      } else {
        res.end('second')
      }
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n' +
      'GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.absent(raw.includes('INJECTED'), 'nothing written for the 204')
  t.is(raw.split(/HTTP\/1\.1 \d\d\d/).length - 1, 2, 'one status line each')

  await closeServer(server)
})

// A 304 stands in for a response that would have had a body, so it may carry
// the length of the one it is replacing.
test('a 304 keeps a content length that was set for it', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.statusCode = 304
      res.setHeader('Content-Length', '100')
      res.end()
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.includes('Content-Length: 100\r\n'), 'length kept')
  t.absent(raw.includes('Transfer-Encoding'), 'not chunked')

  await closeServer(server)
})

// Chunked is the only coding this side can apply, and sending both framing
// headers is the classic way to have two peers disagree about where a message
// ends.
test('a chunked transfer encoding set by the caller is taken over', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.setHeader('Transfer-Encoding', 'chunked')

      if (req.url === '/split') {
        res.write('hel')
        res.end('lo')
      } else {
        res.end('hello')
      }
    })
  )

  for (const path of ['/one', '/split']) {
    const raw = await rawRequest(
      server.address().port,
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
    )

    t.is(raw.split('Transfer-Encoding: chunked\r\n').length - 1, 1, `announced once for ${path}`)
    t.absent(raw.includes('Content-Length'), `no content length for ${path}`)
    t.ok(raw.endsWith('\r\n0\r\n\r\n'), `body chunked and terminated for ${path}`)
  }

  await closeServer(server)
})

// The same framing hazards apply to a request, where the peer reading the
// surplus is a server that will act on it.
test('request body longer than its content length is not sent', async (t) => {
  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {})
      socket.on('data', () => t.fail('nothing should be sent'))
    })
  )

  const agent = new http.Agent({ port: server.address().port })

  const req = http.request({ agent, method: 'POST' })

  req.setHeader('Content-Length', '2')
  req.end('SMUGGLED BODY')

  const err = await waitFor(req, 'error')

  t.is(err.code, 'CONTENT_LENGTH_MISMATCH', 'reported on the request')

  agent.destroy()

  await pause(100)

  t.pass('nothing reached the peer')

  await closeServer(server)
})

test('request that carries no body drops the framing it announced', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await listen(
    http.createServer((req, res) => {
      sub.is(req.headers['content-length'], undefined, 'no content length')
      sub.is(req.headers['transfer-encoding'], undefined, 'not chunked')

      res.end('ok')
    })
  )

  const agent = new http.Agent({ port: server.address().port })

  // A server told to read a body that never arrives reads the next request as
  // one instead.
  const result = await request({ agent, headers: { 'content-length': '5' } })

  await sub

  t.is(result.response.statusCode, 200, 'request understood')

  agent.destroy()

  await closeServer(server)
})

// A list cannot be folded onto one line when its own values may contain the
// separator, which is why `Set-Cookie` may only ever appear once per line. And
// what goes out one field per element has to come back one element per field, or
// a consumer would have to split on a separator the values may contain.
test('a list header value is sent and received as one field per element', async (t) => {
  const cookies = ['a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT', 'b=2']

  const server = await listen(
    http.createServer((req, res) => {
      res.setHeader('Set-Cookie', cookies)
      res.end('ok')
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.includes(`Set-Cookie: ${cookies[0]}\r\n`), 'first cookie intact')
  t.ok(raw.includes(`Set-Cookie: ${cookies[1]}\r\n`), 'second cookie on its own line')

  const { response } = await request({ port: server.address().port })

  t.ok(Array.isArray(response.headers['set-cookie']), 'received as a list')
  t.alike(response.headers['set-cookie'], cookies, 'every cookie intact')

  await closeServer(server)
})

// `Cookie` is the exception: it may only appear once, and its list separator is
// `; ` rather than a comma.
test('a cookie list header value is folded onto one line', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.setHeader('Cookie', ['a=1', 'b=2'])
      res.end('ok')
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.includes('Cookie: a=1; b=2\r\n'), 'folded with the right separator')

  await closeServer(server)
})

// A header bag that inherits from `Object.prototype` answers for names nobody
// set, and `__proto__` changes the bag rather than being stored in it.
test('header lookups ignore anything not actually set', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    t.absent(res.hasHeader(name), `${name} is not a header`)
    t.is(res.getHeader(name), undefined, `${name} has no value`)
  }

  const req = new http.IncomingMessage(null, { headers: { 'x-real': 'yes' } })

  t.absent(req.hasHeader('constructor'), 'not a header on a request either')
  t.ok(req.hasHeader('x-real'), 'a header that was set is found')
})

test('incoming header name that would reach the prototype is refused', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = http.createServer((req, res) => {
    sub.fail('request should not be dispatched')
    res.end()
  })

  server.on('clientError', (err) => sub.is(err.code, 'INVALID_HEADER', 'rejected by the parser'))

  await listen(server)

  const raw = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\n__proto__: polluted\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.is(raw, '', 'no response')

  await closeServer(server)
})

// Without backpressure a peer decides how much of a body the process holds on
// to, whether anything is reading it or not.
test('request body is not buffered past what is being read', async (t) => {
  const total = 8 * 1024 * 1024

  let req = null

  const server = await listen(
    http.createServer((r) => {
      req = r // Deliberately never read, as a handler answering 401 would not.
    })
  )

  const socket = await sendBody(server.address().port, total)

  await pause(200)

  t.ok(req !== null, 'request dispatched')

  // Reaching into the stream is the only way to see what is being held, and
  // holding a bounded amount is the whole point.
  t.ok(req._readableState.buffered < total / 8, 'body is not all in memory')

  socket.destroy()

  await closeServer(server)
})

test('request body still arrives in full when it is read slowly', async (t) => {
  const total = 4 * 1024 * 1024

  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    http.createServer((req, res) => {
      let received = 0

      req
        .on('data', (data) => {
          received += data.byteLength
        })
        .on('end', () => {
          sub.is(received, total, 'body received in full')

          res.end('ok')
        })
    })
  )

  const socket = await sendBody(server.address().port, total)

  await sub

  socket.destroy()

  await closeServer(server)
})

test('response body is not buffered past what is being read', async (t) => {
  const total = 8 * 1024 * 1024

  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {})

      socket.once('data', () => {
        socket.write(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${total}\r\n\r\n`))

        const chunk = Buffer.alloc(64 * 1024, 0x62)

        let sent = 0

        const write = () => {
          for (let i = 0; i < 16 && sent < total; i++) {
            socket.write(chunk)
            sent += chunk.byteLength
          }

          if (sent < total) setTimeout(write, 0)
        }

        write()
      })
    })
  )

  const agent = new http.Agent({ port: server.address().port })

  let res = null

  const req = http.request({ agent })

  req.on('error', () => {})
  req.on('response', (r) => {
    res = r // Deliberately never read.
    r.on('error', () => {})
  })
  req.end()

  await pause(600)

  t.ok(res !== null, 'response received')
  t.ok(res._readableState.buffered < total / 8, 'body is not all in memory')

  agent.destroy()

  await closeServer(server)
})

// A peer that answers twice is trying to have the second answer paired up with
// whatever request comes next on the connection.
test('second response on the same connection is refused', async (t) => {
  const server = await rawServer(
    'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nAA' +
      'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nBB'
  )

  const agent = new http.Agent({ keepAlive: true, port: server.address().port })

  let responses = 0

  const req = http.request({ agent })

  req.on('error', () => {})
  req.on('response', (res) => {
    responses++

    res.on('error', () => {})
    res.resume()
  })
  req.end()

  await pause(300)

  t.is(responses, 1, 'only the answer to the request is delivered')

  // A connection that was pooled twice would hand the same socket to two
  // requests, and each would read the other's response.
  t.is([...agent.freeSockets].length, 0, 'connection not pooled')

  agent.destroy()

  await closeServer(server)
})

// A peer that never finishes sending its request would otherwise hold on to the
// connection for as long as it liked.
test('request headers that never arrive time out', async (t) => {
  const server = await listen(
    http.createServer({ headersTimeout: 200 }, (req, res) => {
      t.fail('request should not be dispatched')
      res.end()
    })
  )

  const raw = await rawBytes(server.address().port, 'GET / HTTP/1.1\r\nHost: localhost\r\n')

  t.ok(raw.startsWith('HTTP/1.1 408 Request Timeout\r\n'), 'peer told why')
  t.ok(raw.includes('Connection: close\r\n'), 'connection close announced')

  await closeServer(server)
})

test('request body that never arrives times out', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await listen(
    http.createServer({ headersTimeout: 0, requestTimeout: 200 }, (req) => {
      req
        .on('close', () => sub.absent(req.complete, 'the request stopped short'))
        .on('error', (err) => sub.is(err.code, 'REQUEST_TIMEOUT', 'the reason is reported'))
        .resume()
    })
  )

  const raw = await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nab'
  )

  await sub

  t.ok(raw.startsWith('HTTP/1.1 408 Request Timeout\r\n'), 'peer told why')

  await closeServer(server)
})

test('a request cut short with nobody listening is not an unhandled error', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = http.createServer((req) => {
    // Deliberately no error listener, which must not take the process down. The
    // close is all a consumer gets, and `complete` is what tells it apart from a
    // request that arrived whole.
    req.on('close', () => sub.absent(req.complete, 'the request stopped short')).resume()
  })

  server.requestTimeout = 100

  await listen(server)

  await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nab'
  )

  await sub

  t.pass('survived without an error listener')

  await closeServer(server)
})

test('a response cut short with nobody listening is not an unhandled error', async (t) => {
  const sub = t.test()
  sub.plan(1)

  // Promises a hundred bytes, sends seven, then goes away.
  const server = await rawServer('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial', {
    destroy: true
  })

  const req = http.request({ port: server.address().port, agent: false }, (res) => {
    // Deliberately no error listener, which must not take the process down. The
    // close is all a consumer gets, and `complete` is what tells it apart from a
    // response that arrived whole.
    res.on('close', () => sub.absent(res.complete, 'the response stopped short')).resume()
  })

  req.on('error', () => t.fail('request should not fail'))

  req.end()

  await sub

  t.pass('survived without an error listener')

  await closeServer(server)
})

test('a response that fails to parse with nobody listening is not an unhandled error', async (t) => {
  const sub = t.test()
  sub.plan(1)

  // A chunk length that is no length at all, which only shows up once the
  // response has already been handed over.
  const server = await rawServer('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\n')

  const req = http.request({ port: server.address().port, agent: false }, (res) => {
    res.on('close', () => sub.absent(res.complete, 'the response stopped short')).resume()
  })

  req.on('error', () => {})

  req.end()

  await sub

  t.pass('survived without an error listener')

  await closeServer(server)
})

// Time spent waiting on this side is not the peer's fault, so a handler that
// reads a body slowly must not have it taken away.
test('request that is read slowly does not time out', async (t) => {
  const total = 512 * 1024

  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    http.createServer({ headersTimeout: 0, requestTimeout: 300 }, (req, res) => {
      let received = 0

      // Read in bursts, so that most of the time is spent not reading.
      const pump = () => {
        let data

        while ((data = req.read()) !== null) received += data.byteLength

        if (received < total) return setTimeout(pump, 30)

        sub.is(received, total, 'body received in full')

        res.end('ok')
      }

      pump()
    })
  )

  const socket = await sendBody(server.address().port, total)

  await sub

  socket.destroy()

  await closeServer(server)
})

test('timeouts can be turned off', async (t) => {
  const server = await listen(
    http.createServer({ headersTimeout: 0, requestTimeout: 0 }, (req, res) => res.end('ok'))
  )

  t.is(server.headersTimeout, 0, 'headers timeout off')

  const peer = rawIdle(server.address().port, 'GET / HTTP/1.1\r\nHost: localhost\r\n')

  await pause(500)

  // Still waiting for the rest of the headers rather than having given up.
  t.is(peer.response, '', 'connection left alone')

  peer.socket.destroy()

  await closeServer(server)
})

test('a request that fails to parse mid body is still answered', async (t) => {
  const server = await listen(
    http.createServer((req, res) => req.resume().on('end', () => res.end('ok')))
  )

  // The headers parse, so a request exists and is mid body when the chunk size
  // turns out to be nonsense. Destroying the request must not take the socket
  // down with it, or the answer never reaches the peer.
  const response = await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\nZZZZ\r\n'
  )

  t.ok(response.includes('400 Bad Request'), 'the peer is told the request was bad')

  await closeServer(server)
})

test('a clientError handler can answer a request that failed mid body', async (t) => {
  const server = http.createServer((req) => req.resume())

  server.on('clientError', (err, socket) =>
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 7\r\n\r\nrefused')
  )

  await listen(server)

  const response = await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\nZZZZ\r\n'
  )

  t.ok(response.includes('refused'), "the application's own answer reaches the peer")

  await closeServer(server)
})

test('connection upgrade without an upgrade header is an ordinary request', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = http.createServer((req, res) => {
    sub.pass('handled as a request')
    res.end('ok')
  })

  // Naming no protocol, the peer has not asked for an upgrade, so it must not be
  // able to take the socket away from the request handler.
  server.on('upgrade', () => sub.fail('must not be handled as an upgrade'))

  await listen(server)

  const response = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: upgrade, close\r\n\r\n'
  )

  t.ok(response.includes('200 OK'), 'answered as a request')

  await sub

  await closeServer(server)
})

test('a response that claims an upgrade without naming one is an ordinary response', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await rawServer(
    'HTTP/1.1 200 OK\r\nConnection: upgrade\r\nContent-Length: 2\r\n\r\nok',
    { end: true }
  )

  const req = http.request({ port: server.address().port, agent: false }, (res) => {
    sub.is(res.statusCode, 200, 'delivered as a response')
    res.resume()
  })

  // A peer that names no protocol has not offered an upgrade, so it must not be
  // able to take the socket away from the consumer waiting on a response.
  req.on('upgrade', () => sub.fail('must not be handled as an upgrade'))
  req.on('error', () => {})
  req.end()

  await sub

  await closeServer(server)
})

// Only a `101` switches protocols. A peer that names an upgrade alongside any
// other status is answering the request, and taking the socket away on the
// strength of the headers alone would let it turn a refused handshake into one
// the consumer's upgrade handler sees as having been accepted.
test('a response that names an upgrade without switching is an ordinary response', async (t) => {
  const sub = t.test()
  sub.plan(3)

  for (const status of ['200 OK', '204 No Content', '403 Forbidden']) {
    const server = await rawServer(
      `HTTP/1.1 ${status}\r\nUpgrade: weird-protocol\r\nConnection: upgrade\r\nContent-Length: 0\r\n\r\n`,
      { end: true }
    )

    const req = http.request({ port: server.address().port, agent: false }, (res) => {
      sub.is(res.statusCode, parseInt(status, 10), `${status} delivered as a response`)
      res.resume()
    })

    req.on('upgrade', () => sub.fail('must not be handled as an upgrade'))
    req.on('error', () => {})
    req.end()

    await waitFor(req, 'close')

    await closeServer(server)
  }

  await sub
})

// An interim response is not the one the request was waiting for, whatever
// headers it carries, so it must not be able to end the exchange either.
test('an interim response that names an upgrade is still interim', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await rawServer(
    'HTTP/1.1 103 Early Hints\r\nUpgrade: weird-protocol\r\nConnection: upgrade\r\n\r\n' +
      'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi',
    { end: true }
  )

  const req = http.request({ port: server.address().port, agent: false }, (res) => {
    sub.is(res.statusCode, 200, 'the real response still arrives')
    res.resume()
  })

  req.on('information', (info) => sub.is(info.statusCode, 103, 'reported as interim'))
  req.on('upgrade', () => sub.fail('must not be handled as an upgrade'))
  req.on('error', () => {})
  req.end()

  await sub

  await closeServer(server)
})

test('a connection reused from the response close handler still reads', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {})
      socket.on('data', () =>
        socket.write(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
      )
    })
  )

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const first = http.request({ agent }, (res) => {
    // The socket goes back into the pool here, before the first request has
    // closed, so the connection must not mistake that close for the second
    // request's and forget which request it is on.
    res.on('close', () => {
      const second = http.request({ agent }, (res2) => {
        sub.is(res2.statusCode, 200, 'the reused connection still reads responses')

        res2.resume().on('end', () => agent.destroy())
      })

      second.on('error', () => {})
      second.end()
    })

    res.resume()
  })

  first.on('error', () => {})
  first.end()

  await sub

  await closeServer(server)
})

test('a 101 that names no protocol is an ordinary response', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await rawServer('HTTP/1.1 101 Switching Protocols\r\n\r\n', { end: true })

  const req = http.request({ port: server.address().port, agent: false }, (res) => {
    sub.is(res.statusCode, 101, 'delivered as a response')

    res
      .on('data', () => sub.fail('no body expected'))
      .on('end', () => sub.pass('response ended'))
      .resume()
  })

  // Having named nothing to switch to, the peer has handed the connection to no
  // one, so there is nothing to upgrade and nothing still to come.
  req.on('upgrade', () => sub.fail('must not be handled as an upgrade'))
  req.on('information', () => sub.fail('must not be handled as interim'))
  req.on('error', () => {})
  req.end()

  await sub

  await closeServer(server)
})

test('a connection is not reused after a 101 that names no protocol', async (t) => {
  const sub = t.test()
  sub.plan(2)

  // The parser stops reading for good at any 101, so the connection cannot carry
  // another exchange and must not go back into the pool offering one. Counted
  // across connections, so the second request is answered wherever it turns up.
  let n = 0

  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {})
      socket.on('data', () => {
        if (++n === 1) socket.write(Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'))
        else socket.write(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
      })
    })
  )

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const first = http.request({ agent }, (res) => {
    const socket = first.socket

    res.on('close', () => {
      const second = http.request({ agent }, (res2) => {
        sub.is(res2.statusCode, 200, 'the next request is answered')
        sub.not(second.socket, socket, 'on a connection of its own')

        res2.resume().on('end', () => agent.destroy())
      })

      second.on('error', () => {})
      second.end()
    })

    res.resume()
  })

  first.on('error', () => {})
  first.end()

  await sub

  await closeServer(server)
})

test('a CONNECT request is handed over as a tunnel', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = http.createServer(() => sub.fail('must not be handled as a request'))

  server.on('connect', (req, socket, head) => {
    sub.is(req.url, 'localhost:443', 'authority received')
    sub.alike(head, Buffer.from('tunnel bytes'), 'head belongs to the tunnel')

    socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
  })

  await listen(server)

  const response = await rawBytes(
    server.address().port,
    'CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\ntunnel bytes'
  )

  t.ok(response.includes('200 Connection Established'), 'tunnel established')

  await sub

  await closeServer(server)
})

test('a CONNECT response is handed over as a tunnel', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await rawServer('HTTP/1.1 200 Connection Established\r\n\r\ntunnel bytes')

  const req = http.request({
    port: server.address().port,
    method: 'CONNECT',
    path: 'localhost:443',
    agent: false
  })

  req.on('response', () => sub.fail('must not be delivered as a response'))

  req.on('connect', (res, socket, head) => {
    sub.is(res.statusCode, 200, 'tunnel established')
    sub.alike(head, Buffer.from('tunnel bytes'), 'head belongs to the tunnel')

    socket.destroy()
  })

  req.on('error', () => {})
  req.end()

  await sub

  await closeServer(server)
})

// Whatever a CONNECT is answered with is the answer about the tunnel, and only
// the caller can decide what a refusal means. Delivering it as an ordinary
// response instead would leave a caller that is waiting on the handover, as one
// written against Node.js is, waiting on an event that never comes.
test('a CONNECT that is refused is handed over with the refusal', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await rawServer(
    'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 6\r\n\r\nnope!\n'
  )

  const req = http.request({
    port: server.address().port,
    method: 'CONNECT',
    path: 'localhost:443',
    agent: false
  })

  req.on('response', () => sub.fail('must not be delivered as a response'))

  req.on('connect', (res, socket, head) => {
    sub.is(res.statusCode, 407, 'the refusal reaches the caller')
    sub.alike(head, Buffer.from('nope!\n'), 'along with what came with it')

    socket.destroy()
  })

  req.on('error', () => {})
  req.end()

  await sub

  await closeServer(server)
})

test('a CONNECT request is sent without a body framing', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {})

      socket.once('data', (data) => {
        // Anything after the headers would belong to the tunnel, so framing a
        // body the peer would then wait for has nothing to describe.
        sub.absent(
          /content-length|transfer-encoding/i.test(data.toString()),
          'no framing announced'
        )

        socket.destroy()
      })
    })
  )

  const req = http.request({
    port: server.address().port,
    method: 'CONNECT',
    path: 'localhost:443',
    agent: false
  })

  req.on('error', () => {})
  req.on('connect', (res, socket) => socket.destroy())
  req.end()

  await sub

  await closeServer(server)
})

test('writeHead takes the header list forms', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      if (req.url === '/flat') res.writeHead(200, ['x-a', '1', 'x-b', '2'])
      else {
        res.writeHead(200, [
          ['x-a', '1'],
          ['x-b', '2']
        ])
      }

      res.setHeader('connection', 'close')
      res.end('ok')
    })
  )

  for (const path of ['/flat', '/pairs']) {
    const response = await rawRequest(
      server.address().port,
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`
    )

    t.ok(response.includes('X-A: 1'), `first field sent for ${path}`)
    t.ok(response.includes('X-B: 2'), `second field sent for ${path}`)
  }

  await closeServer(server)
})

// Overwriting would drop every value but the last without saying so.
test('writeHead keeps every value a list of pairs names for the same field', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.writeHead(200, [
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
        ['connection', 'close']
      ])

      res.end('ok')
    })
  )

  const response = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'
  )

  t.ok(response.includes('Set-Cookie: a=1\r\n'), 'the first value was kept')
  t.ok(response.includes('Set-Cookie: b=2\r\n'), 'and so was the second')

  await closeServer(server)
})

test('appendHeader adds to a field rather than replacing it', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.appendHeader('X-A', '1')
      res.appendHeader('x-a', '2')
      res.appendHeader('X-A', ['3', '4'])

      t.alike(res.getHeader('x-a'), ['1', '2', '3', '4'], 'every value was kept')

      res.setHeader('connection', 'close')
      res.end('ok')
    })
  )

  const response = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'
  )

  t.ok(response.includes('X-A: 1\r\nX-A: 2\r\nX-A: 3\r\nX-A: 4\r\n'), 'one line each')

  await closeServer(server)
})

test('appendHeader validates what it is given', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  t.exception(() => res.appendHeader('bad header', '1'), /INVALID_HEADER_NAME/)
  t.exception(() => res.appendHeader('x-a', 'value\r\nInjected: x'), /INVALID_HEADER_VALUE/)

  res.appendHeader('x-a', '1')

  t.exception(() => res.appendHeader('__proto__', '1'), /INVALID_HEADER_NAME/)
  t.is(res.getHeader('x-a'), '1', 'the field that was set is unaffected')
})

test('a server takes a null options bag', async (t) => {
  const server = await listen(new http.Server(null, (req, res) => res.end('ok')))

  const response = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(response.endsWith('\r\n\r\nok'), 'the request was served')

  await closeServer(server)
})

// A peer that is not told how long the connection is worth holding on to has no
// way of telling a socket that is about to be reclaimed from one that is good
// for another request, and so races the server for it.
test('a response says the connection is kept and for how long', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end('ok')))

  const { port } = server.address()

  const kept = await rawUntil(port, 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n', 'ok')

  t.ok(kept.includes('Connection: keep-alive\r\n'), 'the connection is kept')
  t.ok(kept.includes('Keep-Alive: timeout=5\r\n'), 'for as long as the server keeps it')

  server.keepAliveTimeout = 30000

  const longer = await rawUntil(port, 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n', 'ok')

  t.ok(longer.includes('Keep-Alive: timeout=30\r\n'), 'which is whatever the server holds it')

  const closed = await rawRequest(
    port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.absent(closed.includes('Keep-Alive'), 'and nothing is said of a connection being given up')

  await closeServer(server)
})

test('a server that holds connections for no time says nothing of how long', async (t) => {
  const server = await listen(
    http.createServer({ keepAliveTimeout: 0 }, (req, res) => res.end('ok'))
  )

  const response = await rawUntil(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n',
    'ok'
  )

  t.ok(response.includes('Connection: keep-alive\r\n'), 'the connection is still kept')
  t.absent(response.includes('Keep-Alive'), 'but no deadline is named for it')

  await closeServer(server)
})

test('an HTTP/1.0 client that asks to keep the connection is told that it is kept', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.setHeader('content-length', '2')
      res.end('ok')
    })
  )

  const { port } = server.address()

  // An HTTP/1.0 peer closes the connection unless it is told otherwise, so a
  // server that keeps it has to say so. The connection stays open afterwards, so
  // the reply is read up to the end of the body rather than to a close.
  const kept = await rawUntil(
    port,
    'GET / HTTP/1.0\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n',
    'ok'
  )

  t.ok(/Connection: keep-alive/i.test(kept), 'the connection is confirmed as kept')

  const closed = await rawBytes(port, 'GET / HTTP/1.0\r\nHost: localhost\r\n\r\n')

  t.ok(/Connection: close/i.test(closed), 'and closed when it was not asked for')

  await closeServer(server)
})

test('a HEAD response of unknown length announces no framing', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      // Written in pieces, so the length is not known when the headers go out.
      res.write('hello')
      res.end(' there')
    })
  )

  const response = await rawBytes(
    server.address().port,
    'HEAD / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  // Chunked would promise a terminator that is never written, since a HEAD
  // response carries no body to terminate.
  t.absent(/Transfer-Encoding/i.test(response), 'no transfer encoding announced')
  t.absent(/Content-Length/i.test(response), 'no content length announced')
  t.ok(response.includes('200 OK'), 'headers still sent')

  await closeServer(server)
})

// Time spent answering a request is not the peer's fault. The headers deadline is
// there to bound the wait for the next request, which only starts once the
// current one has been answered.
test('a slow handler does not lose its response to the headers timeout', async (t) => {
  const server = await listen(
    http.createServer({ headersTimeout: 200, requestTimeout: 0 }, (req, res) => {
      req.resume()

      setTimeout(() => res.end('the-response-body'), 600)
    })
  )

  const raw = await rawBytes(server.address().port, 'GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n')

  t.ok(raw.includes('200 OK'), 'response sent')
  t.ok(raw.endsWith('the-response-body'), 'response body sent in full')

  await closeServer(server)
})

// A request that is closed after the next one has already been handed the
// connection must not take it away from it, or the request in flight is left
// waiting for a body that is being thrown away.
test('a request that closes late does not detach the next one', async (t) => {
  const sub = t.test()
  sub.plan(1)

  let first = null

  const server = await listen(
    http.createServer((req, res) => {
      if (first === null) {
        // Body deliberately left unread, so that the request stays open past its
        // response and into the next request.
        first = req
      } else {
        const chunks = []

        req
          .on('data', (data) => chunks.push(data))
          .on('end', () =>
            sub.alike(Buffer.concat(chunks), Buffer.from('bb'), 'second body received')
          )
      }

      res.end('ok')
    })
  )

  const raw = new Promise((resolve, reject) => {
    const socket = tcp.createConnection(server.address().port, 'localhost')

    const chunks = []

    socket
      .on('error', reject)
      .on('data', (data) => chunks.push(data))
      .on('end', () => resolve(Buffer.concat(chunks).toString()))

    socket.write(Buffer.from('POST /1 HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\naa'))

    // The second request is opened, then held mid body while the first one is
    // closed underneath it, and only then finished.
    setTimeout(() => {
      socket.write(Buffer.from('POST /2 HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n'))
    }, 100)

    setTimeout(() => first.destroy(), 200)
    setTimeout(() => socket.write(Buffer.from('bb')), 300)
    setTimeout(() => socket.end(), 500)
  })

  await sub

  const response = await raw

  t.is(response.split('HTTP/1.1 200 OK').length - 1, 2, 'both requests answered')
  t.ok(first.destroyed, 'first request closed')

  await closeServer(server)
})

// Whether a handler got around to reading a request it was given says nothing
// about whether the peer is still being waited on.
test('a connection whose request body went unread still counts as idle', async (t) => {
  const server = await listen(
    http.createServer((req, res) => res.end('ok')) // Body deliberately left unread
  )

  const peer = rawIdle(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\naa'
  )

  await waitFor(peer.socket, 'data')
  await pause(100)

  const connection = http.ServerConnection.for([...server.connections][0])

  t.ok(connection.idle, 'connection idle once the request has arrived in full')

  // Would otherwise wait for the headers deadline to reclaim the connection.
  const closed = new Promise((resolve) => server.close(() => resolve(true)))

  t.ok(await within(2000, closed), 'the server closed without waiting on the peer')

  peer.socket.destroy()
})

// Splicing a canned response into one that has already begun would have the peer
// count the status line towards the body it was promised, and read what is left
// over as the start of the next response.
test('a request that fails mid response is not answered over the response', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.setHeader('content-length', '10')
      res.write(Buffer.from('01234'))
      // Response deliberately left half written.
    })
  )

  // The malformed request arrives while the response is still half written.
  const raw = await rawRequest(
    server.address().port,
    'GET /1 HTTP/1.1\r\nHost: localhost\r\n\r\n',
    {
      on: '01234',
      send: 'GET /2 HTTP/1.1\r\nHost: localhost\r\nBad Header\r\n\r\n'
    }
  )

  t.ok(raw.includes('200 OK'), 'response sent')
  t.absent(raw.includes('400 Bad Request'), 'no error response spliced in')
  t.is(raw.split('HTTP/1.1').length - 1, 1, 'only one status line on the wire')

  await closeServer(server)
})

// A name that leads with the field delimiter is an unusual token but a valid
// one, and rewriting its case must not rewrite the name itself: dropping the
// leading `-` would put a second framing header on the wire, past the framing
// the message had already settled on.
test('a header name that leads with a hyphen keeps it', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.setHeader('-content-length', '999')
      res.setHeader('-', 'x')
      res.end('hello')
    })
  )

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.includes('-Content-Length: 999\r\n'), 'the hyphen is kept')
  t.ok(raw.includes('-: x\r\n'), 'a name that is only a hyphen is kept')
  t.is(
    raw.split('\r\nContent-Length:').length - 1,
    1,
    'only the framing content length on the wire'
  )

  await closeServer(server)
})

test('a request header name that leads with a hyphen keeps it', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {})

      socket.once('data', (data) => {
        const raw = data.toString()

        sub.ok(raw.includes('-Content-Length: 999\r\n'), 'the hyphen is kept')
        sub.is(raw.split('\r\nContent-Length:').length - 1, 1, 'one content length on the wire')

        socket.write(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
      })
    })
  )

  await request(
    {
      port: server.address().port,
      method: 'POST',
      agent: false,
      headers: { '-content-length': '999' }
    },
    (client) => client.end('hello')
  )

  await sub

  await closeServer(server)
})

// The parser spends its instruction to skip the body on the first set of headers
// it completes, and an interim response is not the one the request was waiting
// for. Reading the real response as though it carried a body would take the
// bytes of whatever followed on the connection.
test('a HEAD response after an interim response carries no body', async (t) => {
  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {})

      socket.once('data', () => {
        socket.write(
          Buffer.from(
            'HTTP/1.1 103 Early Hints\r\nLink: </s.css>; rel=preload\r\n\r\n' +
              'HTTP/1.1 200 OK\r\nContent-Length: 42\r\nX-Marker: real\r\n\r\n'
          )
        )

        // What a following response on the connection would be. A desynced
        // client reads these as the body of the response above.
        setTimeout(() => {
          socket.write(Buffer.from('HTTP/1.1 500 Server Error\r\nContent-Length: 0\r\n\r\n'))
        }, 100)
      })
    })
  )

  const interim = []

  const result = await request(
    { port: server.address().port, method: 'HEAD', agent: false },
    (client) => {
      client.on('information', (info) => interim.push(info.statusCode))
      client.end()
    }
  )

  t.alike(interim, [103], 'the interim response was surfaced')
  t.is(result.response.statusCode, 200, 'the real response was surfaced')
  t.is(
    Buffer.concat(result.response.chunks).byteLength,
    0,
    'no body was read for the HEAD response'
  )

  await closeServer(server)
})

// A request that has arrived and is only waiting for the connection to free up is
// already in hand. Counting that as idle would put the peer back on the headers
// deadline while its request is being handled.
test('a pipelined request is not answered against the headers timeout', async (t) => {
  const server = await listen(
    http.createServer({ headersTimeout: 200, requestTimeout: 0 }, (req, res) =>
      setTimeout(() => res.end(req.url), 500)
    )
  )

  // Both requests arrive at once, so the second one is held back until the first
  // has been answered, and is then handled for longer than the headers deadline
  // it must not be subject to.
  const raw = await rawRequest(
    server.address().port,
    'GET /a HTTP/1.1\r\nHost: localhost\r\n\r\n' +
      'GET /b HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.is(raw.split('HTTP/1.1 200 OK').length - 1, 2, 'both requests answered')
  t.ok(raw.includes('/a') && raw.includes('/b'), 'both responses were sent')

  await closeServer(server)
})

test('a pipelined request does not leave the connection idle', async (t) => {
  const server = await listen(
    http.createServer((req, res) => setTimeout(() => res.end(req.url), 300))
  )

  const peer = rawIdle(
    server.address().port,
    'GET /a HTTP/1.1\r\nHost: localhost\r\n\r\nGET /b HTTP/1.1\r\nHost: localhost\r\n\r\n'
  )

  // Waits for the first response, at which point the second request is in hand
  // and waiting for the connection.
  await waitFor(peer.socket, 'data')

  const connection = http.ServerConnection.for([...server.connections][0])

  t.absent(connection.idle, 'a connection with a request in hand is not idle')

  peer.socket.destroy()

  await closeServer(server)
})

// A body that was answered without being read leaves the connection paused on
// backpressure, and a paused connection has no deadline running against it, so
// the peer could otherwise hold it open for good.
test('a request body left unread does not hold the connection open', async (t) => {
  const server = await listen(
    http.createServer({ headersTimeout: 0, requestTimeout: 300 }, (req, res) => {
      res.end('ok') // Body deliberately left unread
    })
  )

  const reclaimed = new Promise((resolve) => {
    server.on('connection', (connection) => connection.on('close', () => resolve(true)))
  })

  const socket = tcp.createConnection(server.address().port, 'localhost')

  socket.on('error', () => {})

  socket.on('connect', () => {
    // Announces far more than it sends, so the request never finishes arriving
    // and the stream fills up.
    socket.write(
      Buffer.from('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1048576\r\n\r\n')
    )
    socket.write(Buffer.alloc(65536, 0x61))
  })

  t.ok(await within(2000, reclaimed), 'the connection was reclaimed by the request deadline')

  socket.destroy()

  await closeServer(server)
})

// A socket that has been handed over to another protocol is no longer ours:
// offering it back to the agent as free would write the next request, and
// whatever it carries, into an established tunnel or upgraded stream.
test('a handed over socket is not offered back to the agent', async (t) => {
  const handovers = [
    {
      event: 'upgrade',
      reply:
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      opts: { path: '/ws', headers: { connection: 'Upgrade', upgrade: 'websocket' } }
    },
    {
      event: 'connect',
      reply: 'HTTP/1.1 200 Connection Established\r\n\r\n',
      opts: { method: 'CONNECT', path: 'example.org:443' }
    }
  ]

  for (const { event, reply, opts } of handovers) {
    const server = await listen(
      tcp.createServer((socket) => {
        socket.on('error', () => {})
        socket.once('data', () => socket.write(Buffer.from(reply)))
      })
    )

    const agent = new http.Agent({ keepAlive: true })

    const req = http.request({ port: server.address().port, agent, ...opts })

    req.on('error', () => {})

    const handed = waitFor(req, event)

    req.end()

    // A consumer that drains the response object is what used to release the
    // socket back into the pool.
    ;(await handed).resume()

    await pause(100)

    t.is([...agent.freeSockets].length, 0, `the ${event} socket is not pooled`)

    agent.destroy()

    await closeServer(server)
  }
})

// A socket whose closing this side has decided on has to be taken all the way
// down, since the peer is under no obligation to close its own side and one that
// never does would hold on to the connection for good.
test('a malformed request takes the connection with it', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end()))

  const peer = rawIdle(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nBad\x00Header: value\r\n\r\n'
  )

  await pause(200)

  t.ok(peer.response.startsWith('HTTP/1.1 400 Bad Request\r\n'), 'answered 400')
  t.is(server.connections.size, 0, 'connection taken down without waiting on the peer')

  peer.socket.destroy()

  await closeServer(server)
})

test('a connection the response gives up is taken down', async (t) => {
  const server = await listen(
    http.createServer({ headersTimeout: 0, requestTimeout: 0 }, (req, res) => res.end('ok'))
  )

  const peer = rawIdle(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await pause(200)

  t.ok(peer.response.endsWith('\r\n\r\nok'), 'the whole response went out first')
  t.is(server.connections.size, 0, 'connection taken down without waiting on the peer')

  peer.socket.destroy()

  await closeServer(server)
})

test('closing the server leaves an upgraded connection alone', async (t) => {
  t.plan(4)

  const server = http.createServer()

  server.on('upgrade', (req, socket) => {
    socket
      .on('error', () => {})
      .on('data', () => socket.write(Buffer.from('pong')))
      .write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
      )
  })

  await listen(server)

  const socket = tcp.createConnection(server.address().port, 'localhost')

  socket.on('error', () => {})

  let received = ''

  socket.on('data', (data) => {
    received += data.toString()
  })

  socket.write(
    Buffer.from(
      'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
    )
  )

  await pause(100)

  t.ok(received.startsWith('HTTP/1.1 101'), 'the connection was handed over')

  received = ''
  socket.write(Buffer.from('ping'))

  await pause(100)

  t.is(received, 'pong', 'the tunnel carries traffic')

  // The socket is no longer HTTP, so it is not the server's to reclaim, and the
  // close only completes once the peer has gone of its own accord.
  server.close(() => t.pass('server closed'))

  await pause(100)

  received = ''
  socket.write(Buffer.from('ping'))

  await pause(100)

  t.is(received, 'pong', 'the tunnel is left alone')

  socket.destroy()
})

test('the request socket outlives the request body', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await listen(
    http.createServer(async (req, res) => {
      // The whole request arrived before the handler ever ran, but the socket is
      // still who the consumer is talking to.
      await pause(10)

      sub.ok(req.socket !== null, 'the socket is still there')
      sub.is(typeof req.socket.remoteAddress, 'string', 'the peer can still be named')

      res.end('ok')
    })
  )

  const response = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.ok(response.endsWith('ok'), 'the request was answered')

  await closeServer(server)
})

test('a header value may carry obs-text', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    http.createServer((req, res) => {
      sub.is(req.headers['x-name'], 'caf\xe9', 'received as one character per byte')

      res.setHeader('x-name', req.headers['x-name'])
      res.end('ok')
    })
  )

  const response = await rawBytes(
    server.address().port,
    Buffer.concat([
      Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nX-Name: caf'),
      Buffer.from([0xe9]),
      Buffer.from('\r\n\r\n')
    ])
  )

  await sub

  t.ok(response.includes('X-Name: '), 'sent back')

  await closeServer(server)
})

test('a pipelined request is not answered after the connection is gone', async (t) => {
  const dispatched = []

  const server = await listen(
    http.createServer(async (req, res) => {
      dispatched.push(req.url)

      for await (const chunk of req) void chunk

      await pause(200)

      res.end('ok')
    })
  )

  const socket = tcp.createConnection(server.address().port, 'localhost')

  socket.on('error', () => {})

  socket.write(
    Buffer.from(
      'POST /1 HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\nhi' +
        'POST /2 HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\nhi'
    )
  )

  await pause(100)

  socket.destroy()

  await pause(400)

  t.alike(dispatched, ['/1'], 'the second request was never dispatched')

  await closeServer(server)
})

test('a slow response is not cut off by the agent timeout', async (t) => {
  const server = await listen(
    http.createServer(async (req, res) => {
      // Longer than the timeout, which belongs to whoever is using the socket
      // rather than to the agent.
      await pause(300)

      res.end('response')
    })
  )

  const agent = new http.Agent({ port: server.address().port, timeout: 100 })

  const chunks = []

  let timedOut = false
  let ended = false

  const req = http.request({ agent }, (res) => {
    res
      .on('data', (data) => chunks.push(data))
      .on('end', () => {
        ended = true
      })
  })

  req.on('timeout', () => {
    timedOut = true
  })

  req.end()

  await waitFor(req, 'close')

  t.ok(timedOut, 'the timeout was reported to the request')
  t.ok(ended, 'the response still arrived')
  t.alike(Buffer.concat(chunks), Buffer.from('response'), 'body intact')

  agent.destroy()

  await closeServer(server)
})

test('losing the socket under an unanswered request is reported', async (t) => {
  const server = await listen(
    http.createServer(async (req, res) => {
      await pause(1000)

      res.end()
    })
  )

  const agent = new http.Agent({ port: server.address().port })

  const events = []

  const req = http.request({ agent }, () => events.push('response'))

  req.on('error', (err) => events.push(err.code))

  req.end()

  await pause(100)

  agent.destroy()

  await waitFor(req, 'close')

  t.alike(events, ['CONNECTION_LOST'], 'the request was told that it failed')

  await closeServer(server)
})

test('a connection is only pooled with one that was made the same way', (t) => {
  // Laid out as Node.js lays it out, since an override has to agree with it.
  const agent = new http.Agent()

  t.is(agent.getName({}), 'localhost::')
  t.is(agent.getName({ host: 'example.org', port: 80 }), 'example.org:80:')
  t.is(agent.getName({ host: 'example.org', port: 80, family: 6 }), 'example.org:80::6')
  t.is(
    agent.getName({ host: 'example.org', port: 80, localAddress: '127.0.0.1' }),
    'example.org:80:127.0.0.1'
  )
  t.is(agent.getName({ socketPath: '/tmp/http.sock' }), 'localhost:::/tmp/http.sock')
  t.is(
    agent.getName({
      host: 'example.org',
      port: 80,
      localAddress: '127.0.0.1',
      family: 4,
      socketPath: '/tmp/http.sock'
    }),
    'example.org:80:127.0.0.1:4:/tmp/http.sock'
  )
})

test('a message that cannot be framed reports it rather than throwing', async (t) => {
  t.plan(7)

  const server = http.createServer()

  const seen = []

  server.on('request', (req, res) => {
    res.on('error', (err) => seen.push(req.url + ':' + err.code))

    res.setHeader('transfer-encoding', 'gzip')

    // Never thrown from underneath the caller, as Node.js never throws one out
    // of `write` or `end` either.
    try {
      if (req.url === '/write') {
        // A message that has failed is not going to take any more of the body.
        t.absent(res.write('body'), 'write refused the body')
      } else if (req.url === '/end') {
        res.end('body')

        t.pass('end did not throw')
      } else {
        res.end()

        t.pass('empty end did not throw')
      }
    } catch (err) {
      t.fail(req.url + ' threw ' + err.code)
    }
  })

  await listen(server)

  for (const path of ['/write', '/end', '/empty']) {
    const peer = rawIdle(server.address().port, `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`)

    await pause(100)

    t.is(peer.response, '', 'nothing went out for ' + path)

    peer.socket.destroy()
  }

  t.alike(
    seen,
    [
      '/write:INVALID_TRANSFER_ENCODING',
      '/end:INVALID_TRANSFER_ENCODING',
      '/empty:INVALID_TRANSFER_ENCODING'
    ],
    'each failure was reported on its response'
  )

  await closeServer(server)
})

test('a body that was never asked for gives up the connection', async (t) => {
  const server = http.createServer()

  // Answered without ever telling the client to send its body, which it may
  // therefore still be holding on to.
  server.on('checkContinue', (req, res) => {
    res.writeHead(400)
    res.end('nope')
  })

  await listen(server)

  const peer = rawIdle(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: 5\r\n\r\n'
  )

  await pause(200)

  t.ok(peer.response.includes('400 Bad Request'), 'answered 400')
  t.ok(peer.response.includes('Connection: close'), 'the connection is not reused')

  peer.socket.destroy()

  await closeServer(server)
})

test('a body that was asked for keeps the connection', async (t) => {
  const server = http.createServer()

  server.on('checkContinue', (req, res) => {
    res.writeContinue()

    res.writeHead(400)
    res.end('nope')
  })

  await listen(server)

  const response = await rawUntil(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: 0\r\n\r\n',
    'nope'
  )

  t.ok(response.startsWith('HTTP/1.1 100 Continue\r\n\r\n'), 'the body was asked for')
  t.absent(response.includes('Connection: close'), 'the connection is kept')

  await closeServer(server)
})

test('an expectation nothing understands is refused', async (t) => {
  const server = await listen(http.createServer(() => t.fail('the request should not be handled')))

  const peer = rawIdle(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nExpect: the-impossible\r\nContent-Length: 0\r\n\r\n'
  )

  await pause(200)

  t.ok(peer.response.includes('417 Expectation Failed'), 'answered 417')

  peer.socket.destroy()

  await closeServer(server)
})

test('an expectation can be answered by a checkExpectation handler', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = http.createServer(() => t.fail('the request should not be handled'))

  server.on('checkExpectation', (req, res) => {
    sub.is(req.headers.expect, 'the-impossible', 'the expectation is readable')

    res.end('handled')
  })

  await listen(server)

  const peer = rawIdle(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nExpect: the-impossible\r\nContent-Length: 0\r\n\r\n'
  )

  await pause(200)

  t.ok(peer.response.includes('200 OK'), 'answered by the handler')

  await sub

  peer.socket.destroy()

  await closeServer(server)
})

// RFC 9110 leaves an HTTP/1.0 client no way to understand a 1xx, so there is
// nothing to answer, whatever it expected, and the request is handled as any
// other. A 100 would be read as the response to the request instead.
test('an expectation from an HTTP/1.0 client is left alone', async (t) => {
  const expectations = []

  const server = await listen(
    http.createServer((req, res) => {
      expectations.push(req.headers.expect)

      req.resume().on('end', () => res.end('ok'))
    })
  )

  for (const expect of ['100-continue', 'the-impossible']) {
    const response = await rawBytes(
      server.address().port,
      `POST / HTTP/1.0\r\nHost: localhost\r\nExpect: ${expect}\r\nContent-Length: 2\r\n\r\nhi`
    )

    t.absent(response.includes('100 Continue'), `no interim response for ${expect}`)
    t.ok(response.includes('200 OK'), `${expect} answered normally`)
  }

  t.alike(expectations, ['100-continue', 'the-impossible'], 'both reached the handler')

  await closeServer(server)
})

// A caller that sends the headers itself, before writing anything, still needs
// the body framed: headers that announce no body at all turn whatever follows
// them into the start of the next message on the connection.
test('flushed headers frame the response', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.flushHeaders()
      res.write('a')
      res.end('b')
    })
  )

  const response = await rawUntil(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n',
    '0\r\n\r\n'
  )

  t.ok(response.includes('Transfer-Encoding: chunked\r\n'), 'framed as chunked')
  t.absent(response.includes('Content-Length'), 'not framed twice')
  t.ok(response.endsWith('1\r\na\r\n1\r\nb\r\n0\r\n\r\n'), 'body chunked and terminated')

  await closeServer(server)
})

test('flushed headers frame the response of a pipelined pair', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.flushHeaders()
      res.end(req.url)
    })
  )

  const response = await rawUntil(
    server.address().port,
    'GET /one HTTP/1.1\r\nHost: localhost\r\n\r\nGET /two HTTP/1.1\r\nHost: localhost\r\n\r\n',
    '/two'
  )

  // Two framed responses rather than one whose body swallows the other.
  t.is(response.split('HTTP/1.1 200 OK').length - 1, 2, 'both responses framed')

  await closeServer(server)
})

test('flushed headers frame the request', async (t) => {
  const handled = []

  const server = await listen(
    http.createServer((req, res) => {
      handled.push(req.method + ' ' + req.url)

      req.resume()
      res.end('ok')
    })
  )

  const client = http.request({
    port: server.address().port,
    method: 'POST',
    path: '/upload',
    agent: false
  })

  client.on('error', () => {})
  client.on('response', (res) => res.resume())

  client.flushHeaders()

  // Body bytes that look like a request of their own. Unframed they would be
  // read as one.
  client.end('GET /admin HTTP/1.1\r\nHost: localhost\r\n\r\n')

  await pause(200)

  t.alike(handled, ['POST /upload'], 'one request reached the server, the one that was made')

  await closeServer(server)
})

// A request that has not been written in full leaves the peer waiting for the
// rest of a body it was promised, so anything sent next on the connection would
// be read as the remainder of it.
test('a connection is not reused after an unfinished request', async (t) => {
  const server = await rawServer(
    'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n'
  )

  const agent = new http.Agent({ keepAlive: true })

  const client = http.request({
    port: server.address().port,
    method: 'POST',
    agent,
    headers: { 'content-length': 1024 }
  })

  client.on('error', () => {})

  // Part of the body that was promised, and no more.
  client.write(Buffer.alloc(16, 0x41))

  const response = await waitFor(client, 'response')

  response.resume()

  await waitFor(response, 'end')
  await pause(100)

  t.is([...agent.freeSockets].length, 0, 'the socket was not pooled')
  t.is([...agent.sockets].length, 0, 'and it was taken down')

  agent.destroy()

  await closeServer(server)
})

test('a connection is reused after a request that was written in full', async (t) => {
  const server = await rawServer(
    'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n'
  )

  const agent = new http.Agent({ keepAlive: true })

  const client = http.request({
    port: server.address().port,
    method: 'POST',
    agent,
    headers: { 'content-length': 2 }
  })

  client.on('error', () => {})
  client.end('ab')

  const response = await waitFor(client, 'response')

  response.resume()

  await waitFor(response, 'end')
  await pause(100)

  t.is([...agent.freeSockets].length, 1, 'the socket was pooled')

  agent.destroy()

  await closeServer(server)
})

// What the peer said too much of would be read as the answer to whatever the
// connection carried next.
test('a connection the peer said too much on is not reused', async (t) => {
  const server = await rawServer('HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\naEXTRA')

  const agent = new http.Agent({ keepAlive: true })

  const client = http.request({ port: server.address().port, agent })

  client.on('error', () => {})
  client.end()

  const response = await waitFor(client, 'response')

  response.resume()

  await waitFor(response, 'end')
  await pause(100)

  t.is([...agent.freeSockets].length, 0, 'the socket was not pooled')

  agent.destroy()

  await closeServer(server)
})

// The same thing said a different way, as a HEAD response is framed as though it
// had a body but the bytes are never read.
test('a connection is not reused after a body arrives for a HEAD request', async (t) => {
  const server = await rawServer('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello')

  const agent = new http.Agent({ keepAlive: true })

  const client = http.request({ port: server.address().port, method: 'HEAD', agent })

  client.on('error', () => {})
  client.end()

  const response = await waitFor(client, 'response')

  response.resume()

  await waitFor(response, 'end')
  await pause(100)

  t.is([...agent.freeSockets].length, 0, 'the socket was not pooled')

  agent.destroy()

  await closeServer(server)
})

// Both were asked for, so arriving together is not the peer saying too much.
test('a connection is reused after an interim response arrives with the final one', async (t) => {
  const server = await rawServer(
    'HTTP/1.1 102 Processing\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\na'
  )

  const agent = new http.Agent({ keepAlive: true })

  const client = http.request({ port: server.address().port, agent })

  client.on('error', () => {})
  client.end()

  const response = await waitFor(client, 'response')

  response.resume()

  await waitFor(response, 'end')
  await pause(100)

  t.is([...agent.freeSockets].length, 1, 'the socket was pooled')

  agent.destroy()

  await closeServer(server)
})

// The field values are checked against the Latin-1 range, so a value above
// `\x7f` is one byte on the wire rather than the two UTF-8 would spend.
test('header values above ASCII are sent as Latin-1', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.setHeader('x-test', '\xe9\xff')
      res.end()
    })
  )

  const received = await new Promise((resolve) => {
    const socket = tcp.createConnection(server.address().port, 'localhost')

    let raw = ''

    socket.on('error', () => {})
    socket.on('data', (data) => {
      raw += data.toString('latin1')

      if (raw.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(raw)
      }
    })

    socket.write(Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'))
  })

  t.ok(received.includes('X-Test: \xe9\xff\r\n'), 'one byte per character')

  const peer = await rawServer('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')

  let sent = ''

  peer.on('connection', (socket) => socket.on('data', (data) => (sent += data.toString('latin1'))))

  await request({ port: peer.address().port, agent: false, headers: { 'x-test': '\xe9\xff' } })

  t.ok(sent.includes('X-Test: \xe9\xff\r\n'), 'and on the way out too')

  await closeServer(peer)
  await closeServer(server)
})

// A value that answers a second coercion differently has nothing to gain by it:
// the string is checked again as it is serialized, so the message is refused
// rather than going out carrying a field nobody set.
test('a header value that changes under coercion is refused', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const shifty = {
    coerced: 0,
    toString() {
      return ++this.coerced > 1 ? 'x\r\nX-Injected: yes' : 'harmless'
    }
  }

  const server = await listen(
    http.createServer((req, res) => {
      res.on('error', (err) => sub.is(err.code, 'INVALID_HEADER_VALUE', 'reported on the response'))

      res.setHeader('x-foo', shifty)
      res.end('ok')
    })
  )

  server.on('clientError', () => {})

  const raw = await rawBytes(server.address().port, 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')

  await sub

  t.is(raw, '', 'no part of the response went out')

  await closeServer(server)
})

// The status message goes onto the status line, so a value that coerces to
// something else once it has been checked would put a line of its own there.
test('a status message is only ever coerced once', async (t) => {
  let coercions = 0

  // Harmless the first time it is asked and hostile every time after, so a
  // second coercion anywhere between the check and the wire shows up either as
  // an injected field or as a count above one.
  const shifty = {
    toString() {
      return ++coercions > 1 ? 'OK\r\nX-Injected: yes' : 'OK'
    }
  }

  const server = await listen(
    http.createServer((req, res) => {
      res.on('error', () => {})
      res.statusMessage = shifty
      res.end('ok')
    })
  )

  server.on('clientError', () => {})

  const raw = await rawBytes(server.address().port, 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')

  t.absent(raw.includes('X-Injected'), 'nothing was injected')
  t.ok(raw.startsWith('HTTP/1.1 200 OK\r\n'), 'the status line is the one that was checked')
  t.is(coercions, 1, 'the value was asked for once')

  await closeServer(server)
})

test('a status message that names nothing falls back to the reason phrase', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = await listen(
    http.createServer((req, res) => {
      res.statusMessage = undefined

      sub.is(res.statusMessage, null, 'nothing is held onto')

      res.end('ok')
    })
  )

  const raw = await rawUntil(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n',
    'ok'
  )

  await sub

  t.ok(raw.startsWith('HTTP/1.1 200 OK\r\n'), 'the reason phrase stands in')

  await closeServer(server)
})

// Nothing here can offer transport security, so a caller that asked for it is
// refused rather than quietly given a connection in the clear.
test('a request for a secure scheme is refused', async (t) => {
  t.exception(
    () => http.request('https://example.com/secret', { agent: false }),
    /INVALID_PROTOCOL/,
    'https refused'
  )

  t.exception(
    () => http.request({ protocol: 'wss:', host: 'example.com', agent: false }),
    /INVALID_PROTOCOL/,
    'wss refused'
  )

  t.exception(
    () => http.request({ protocol: 'file:', host: 'example.com', agent: false }),
    /INVALID_PROTOCOL/,
    'an unrelated scheme refused'
  )

  const server = await listen(http.createServer((req, res) => res.end('ok')))

  const { response } = await request({
    port: server.address().port,
    protocol: 'http:',
    agent: false
  })

  t.is(response.statusCode, 200, 'http is served')

  await closeServer(server)
})

// A URL writes an IPv6 address inside brackets, which belong to how a host is
// written in a URL rather than to the address itself.
test('a request to an IPv6 URL resolves', async (t) => {
  const server = await listen(
    http.createServer((req, res) => res.end(req.headers.host)),
    0,
    '::1'
  )

  const { port } = server.address()

  // Resolved rather than rejected on failure, so that a host the resolver cannot
  // make sense of reads as a failed assertion rather than as a rejection that
  // takes the run with it.
  const reply = await new Promise((resolve) => {
    const client = http.request(`http://[::1]:${port}/`, { agent: false }, (res) => {
      let body = ''

      res.on('data', (data) => (body += data))
      res.on('end', () => resolve({ body, error: null }))
    })

    client.on('error', (err) => resolve({ body: null, error: err.code }))
    client.end()
  })

  t.is(reply.error, null, 'the URL form reached the server')
  t.is(reply.body, `[::1]:${port}`, 'and the host header keeps its brackets')

  const { response } = await request({ host: '::1', port, agent: false })

  t.is(response.statusCode, 200, 'and the options form still works')

  await closeServer(server)
})

// A URL is only where the request starts out. Taking its word over what the
// caller asked for would quietly undo whatever they did to the path before
// handing it over, so the options decide, as they do under Node.js. The one
// part that does not work that way is the host, which Node.js resolves from
// `hostname` first and which a URL always carries.
test('the options given with a URL take precedence over it', async (t) => {
  const lines = []

  // Bound to the loopback address by name and by number alike, so that which of
  // the two reaches the server says nothing and only the host header does.
  const server = await listen(
    http.createServer((req, res) => {
      lines.push(`${req.method} ${req.url} ${req.headers.host}`)
      res.end()
    }),
    0,
    '127.0.0.1'
  )

  const { port } = server.address()

  const send = (url, opts) =>
    new Promise((resolve, reject) => {
      const client = http.request(url, { agent: false, ...opts }, (res) =>
        res.resume().on('end', resolve)
      )

      client.on('error', reject)
      client.end()
    })

  await send(`http://localhost:${port}/from-url?q=1`)

  t.is(lines.shift(), `GET /from-url?q=1 localhost:${port}`, 'the URL is used on its own')

  await send(`http://localhost:${port}/from-url?q=1`, { path: '/from-opts', method: 'POST' })

  t.is(lines.shift(), `POST /from-opts localhost:${port}`, 'a path given alongside it wins')

  await send(`http://127.0.0.1:${port}/`, { host: 'localhost', port })

  t.is(lines.shift(), `GET / 127.0.0.1:${port}`, 'the hostname the URL carries beats a host')

  await send(`http://127.0.0.1:${port}/`, { hostname: 'localhost', port })

  t.is(lines.shift(), `GET / localhost:${port}`, 'but a hostname given alongside it wins')

  await send(`http://localhost:${port}/`, { port: String(port) })

  t.is(lines.shift(), `GET / localhost:${port}`, 'and a port still reaches it as a string')

  await closeServer(server)
})

// Chunked is the only coding this side can apply, so one it cannot is refused
// rather than left out of the announcement: the body would then go out encoded
// but be read as though it never had been.
test('a transfer coding that is not chunked is refused', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      res.on('error', () => {})
      res.setHeader('transfer-encoding', req.url.slice(1))
      res.end('body')
    })
  )

  const codings = []

  server.on('clientError', (err) => codings.push(err.code))

  await rawBytes(server.address().port, 'GET /gzip,%20chunked HTTP/1.1\r\nHost: localhost\r\n\r\n')
  await rawBytes(server.address().port, 'GET /gzip HTTP/1.1\r\nHost: localhost\r\n\r\n')

  await pause(100)

  t.alike(
    codings,
    ['INVALID_TRANSFER_ENCODING', 'INVALID_TRANSFER_ENCODING'],
    'a list including chunked is refused, and one without it'
  )

  await closeServer(server)
})

// Between requests there is nothing being waited on but the next one, which is
// worth far less patience than an unfinished request.
test('the keep-alive wait is separate from the headers wait', async (t) => {
  const server = await listen(
    http.createServer({ headersTimeout: 5000, keepAliveTimeout: 100 }, (req, res) => res.end('ok'))
  )

  const peer = rawIdle(server.address().port, 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')

  await pause(400)

  t.ok(peer.response.includes('200 OK'), 'the request was answered')
  t.is(server.connections.size, 0, 'and the idle connection was reclaimed')

  peer.socket.destroy()

  await closeServer(server)

  // The other way around: a peer part way through its headers is held to the
  // headers deadline, not the far shorter keep-alive one.
  const strict = await listen(
    http.createServer({ headersTimeout: 100, keepAliveTimeout: 5000 }, (req, res) => res.end('ok'))
  )

  const raw = await rawBytes(strict.address().port, 'GET / HTTP/1.1\r\nHost: localhost\r\n')

  t.ok(raw.startsWith('HTTP/1.1 408 Request Timeout\r\n'), 'the stalled request timed out')

  await closeServer(strict)
})

// Told apart from a request that is merely malformed, as the peer can do
// something about headers that are too large.
test('headers that do not fit are answered 431', async (t) => {
  const server = await listen(
    http.createServer({ maxHeaderSize: 256 }, (req, res) => res.end('ok'))
  )

  const raw = await rawBytes(
    server.address().port,
    `GET / HTTP/1.1\r\nHost: localhost\r\nX-Big: ${'a'.repeat(512)}\r\n\r\n`
  )

  t.ok(raw.startsWith('HTTP/1.1 431 Request Header Fields Too Large\r\n'), 'answered 431')
  t.ok(raw.includes('Connection: close\r\n'), 'connection close announced')

  const malformed = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nBad\x00Header: value\r\n\r\n'
  )

  t.ok(malformed.startsWith('HTTP/1.1 400 Bad Request\r\n'), 'and a malformed one still 400')

  await closeServer(server)
})

test('the header count limit can be set', async (t) => {
  const server = await listen(
    http.createServer({ maxHeadersCount: 4 }, (req, res) => res.end('ok'))
  )

  const headers = Array.from({ length: 8 }, (_, i) => `X-${i}: v\r\n`).join('')

  const raw = await rawBytes(
    server.address().port,
    `GET / HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n`
  )

  t.ok(raw.startsWith('HTTP/1.1 431 Request Header Fields Too Large\r\n'), 'answered 431')

  const ok = await rawUntil(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nX-A: v\r\n\r\n',
    'ok'
  )

  t.ok(ok.includes('200 OK'), 'and a request within the limit is served')

  await closeServer(server)
})

// A copy, so that a caller cannot write to the bag the message serializes from
// and get around the checks `setHeader` runs.
test('the outgoing headers are handed out as a copy', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = await listen(
    http.createServer((req, res) => {
      res.setHeader('x-a', '1')

      const headers = res.headers

      headers['x-b'] = 'bad\r\nX-Injected: yes'

      delete headers['x-a']

      sub.is(res.getHeader('x-a'), '1', 'the field that was set is untouched')
      sub.absent(res.hasHeader('x-b'), 'and the one written to the copy was not taken')

      res.end('ok')
    })
  )

  const raw = await rawUntil(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n',
    'ok'
  )

  await sub

  t.absent(raw.includes('X-Injected'), 'nothing was injected')

  await closeServer(server)
})

// A message that was never given a socket has nowhere to put its body, and
// finding that out from underneath the stream would take the process down.
test('a message with no socket reports it rather than throwing', async (t) => {
  t.plan(1)

  const message = new http.OutgoingMessage()

  message.on('error', (err) => t.is(err.code, 'CONNECTION_LOST', 'the write was reported'))

  message.end('hello')

  await waitFor(message, 'close')
})

test('the server timeout is zero until one is set', (t) => {
  const server = http.createServer()

  t.is(server.timeout, 0, 'no timeout to begin with')

  server.setTimeout(100)

  t.is(server.timeout, 100, 'and the one that was set')
})

// Zero is how long a socket would be kept, which is no time at all, so it asks
// for no pooling in the same way that `false` does.
test('an agent asked to keep sockets for no time does not pool them', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end('ok')))

  const agent = new http.Agent({ keepAlive: 0 })

  const { response } = await request({ port: server.address().port, agent })

  t.is(response.statusCode, 200)

  await pause(100)

  t.is([...agent.freeSockets].length, 0, 'nothing was pooled')

  agent.destroy()

  await closeServer(server)
})

// An agent that is not going to take the socket back leaves the peer holding a
// connection that will never carry anything else, and a server that is not told
// keeps it for as long as its own keep-alive allows.
test('a request gives up a connection the agent will not reuse', async (t) => {
  const requests = []

  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {})
      socket.on('data', (data) => {
        requests.push(data.toString())
        socket.write(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
      })
    })
  )

  await request({ port: server.address().port, agent: false })

  t.ok(requests[0].includes('Connection: close\r\n'), 'the connection was given up')

  requests.length = 0

  // The agent this one goes through keeps its sockets, so there is nothing to
  // tell the peer.
  const agent = new http.Agent({ keepAlive: true })

  await request({ port: server.address().port, agent })

  t.absent(requests[0].includes('Connection: close'), 'and a pooled one was not')

  agent.destroy()

  await closeServer(server)
})

test('a tunnel is not given up by an agent that will not reuse it', async (t) => {
  const requests = []

  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {})
      socket.once('data', (data) => {
        requests.push(data.toString())
        socket.destroy()
      })
    })
  )

  await new Promise((resolve) => {
    const req = http.request({
      port: server.address().port,
      method: 'CONNECT',
      path: 'example.com:443',
      agent: false
    })

    req.on('error', resolve).on('connect', resolve).end()
  })

  t.absent(requests[0].includes('Connection: close'), 'the tunnel was left alone')

  await closeServer(server)
})

// A deadline belongs to the request that asked for it, so a socket that goes
// back into the pool must not carry it over to whoever takes it next.
test('a request timeout does not outlive the request that set it', async (t) => {
  const server = await listen(
    http.createServer((req, res) => {
      if (req.url === '/slow') setTimeout(() => res.end('slow'), 400)
      else res.end('fast')
    })
  )

  const { port } = server.address()
  const agent = new http.Agent({ keepAlive: true })

  await request({ port, path: '/fast', agent }, (client) => {
    client.setTimeout(100)
    client.end()
  })

  await pause(20)

  t.is([...agent.freeSockets].length, 1, 'the socket was pooled')

  let timedOut = false

  await request({ port, path: '/slow', agent }, (client) => {
    client.on('timeout', () => {
      timedOut = true
    })
    client.end()
  })

  t.absent(timedOut, 'the next request did not inherit it')

  agent.destroy()

  await closeServer(server)
})

// A method is a case sensitive token, so `get` is another method entirely and one
// nothing here speaks. Serving it anyway is how the same request line comes to
// mean two things to two hops.
test('a method that nothing speaks is answered 400', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end('ok')))

  const refused = await rawBytes(server.address().port, 'get / HTTP/1.1\r\nHost: localhost\r\n\r\n')

  t.ok(refused.startsWith('HTTP/1.1 400 Bad Request'), 'the lowercase method was refused')

  const served = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(served.startsWith('HTTP/1.1 200 OK'), 'and the one that is spoken was served')

  await closeServer(server)
})

// Whether the request or the response is the one that failed cannot be decided by
// which of them is still in hand: both let go of the connection when they close,
// and which closes first is up to the peer.
test('a request that was answered is not failed when its socket goes', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end('response')))

  const agent = new http.Agent({ keepAlive: true })
  const failures = []

  const req = http.request({ port: server.address().port, agent })

  req.on('error', (err) => failures.push(err.code))

  // The consumer lets go of the response part way through, which takes the socket
  // down with it. The request was answered, so nothing is owed to it.
  req.on('response', (res) => res.destroy())

  req.end()

  await waitFor(req, 'close')
  await pause(50)

  t.alike(failures, [], 'the request was not failed')

  // And a request that was never answered still is.
  const unanswered = http.request({ port: server.address().port, agent })

  const err = await new Promise((resolve) => {
    unanswered.on('error', resolve)
    unanswered.flushHeaders()
    unanswered.socket.destroy()
  })

  t.is(err.code, 'CONNECTION_LOST', 'an unanswered one is reported')

  agent.destroy()

  await closeServer(server)
})

// The other half of what `complete` is for: a message that did arrive whole has
// to say so, or a consumer cannot tell the two apart at all.
test('a message that arrived whole says so', async (t) => {
  let request = null

  const server = await listen(
    http.createServer((req, res) => {
      req.on('close', () => {
        request = req.complete
      })

      req.resume().on('end', () => res.end('body'))
    })
  )

  const response = await new Promise((resolve) => {
    const req = http.request({ port: server.address().port, method: 'POST', agent: false })

    req.on('error', () => resolve(null))
    req.on('response', (res) => {
      t.absent(res.complete, 'not complete while the body is still arriving')

      res.resume().on('close', () => resolve(res.complete))
    })

    req.end('hello')
  })

  t.ok(response, 'the response arrived whole')

  await pause(50)

  t.ok(request, 'and so did the request')

  // And the flag starts out false, so nothing is taken for granted.
  t.absent(new http.IncomingMessage().complete, 'a message starts out incomplete')

  await closeServer(server)
})

// A raw server that replies with the given bytes, so that responses the library
// would not produce itself can be tested. Optionally half-closes its side once
// it has replied, or drops the connection shortly after.
// A socket the agent hands over belongs to whatever protocol took it, and may
// well outlive every request the agent has, so a slot it went on holding would
// be one no request could ever have back.
test('a socket handed over to another protocol is let go of by the agent', async (t) => {
  const handovers = [
    {
      event: 'upgrade',
      reply:
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      opts: { path: '/ws', headers: { connection: 'Upgrade', upgrade: 'websocket' } }
    },
    {
      event: 'connect',
      reply: 'HTTP/1.1 200 Connection Established\r\n\r\n',
      opts: { method: 'CONNECT', path: 'example.org:443' }
    }
  ]

  for (const { event, reply, opts } of handovers) {
    let connections = 0

    const server = await listen(
      tcp.createServer((socket) => {
        const first = ++connections === 1

        socket.on('error', () => {})
        socket.on('data', () => {
          socket.write(
            Buffer.from(first ? reply : 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
          )
        })
      })
    )

    const agent = new http.Agent({
      port: server.address().port,
      keepAlive: true,
      maxSockets: 1
    })

    const req = http.request({ agent, ...opts })

    req.on('error', () => {})

    const handed = new Promise((resolve) => req.on(event, (res, socket) => resolve(socket)))

    req.end()

    const socket = await handed

    t.is([...agent.sockets].length, 0, `the ${event} socket is not one the agent holds`)

    const behind = await within(1000, request({ agent, path: '/next' }))

    t.is(behind && behind.response.statusCode, 200, 'a request behind it is still served')
    t.is(connections, 2, 'on a socket of its own')

    socket.destroy()
    agent.destroy()

    await closeServer(server)
  }
})

// The consumer of a tunnel may be done writing long before the peer is done
// sending, so the agent must not take the socket down with its write side.
test('a tunnel outlives the write side its consumer closes', async (t) => {
  const peers = []

  const server = await listen(
    tcp.createServer({ allowHalfOpen: true }, (socket) => {
      peers.push(socket)

      socket.on('error', () => {})
      socket.once('data', () =>
        socket.write(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'))
      )
    })
  )

  const agent = new http.Agent({ keepAlive: true })

  const req = http.request({
    port: server.address().port,
    agent,
    method: 'CONNECT',
    path: 'example.org:443',
    allowHalfOpen: true
  })

  req.on('error', () => {})

  const handed = new Promise((resolve) => req.on('connect', (res, socket) => resolve(socket)))

  req.end()

  const tunnel = await handed

  const received = []

  tunnel.on('error', () => {}).on('data', (data) => received.push(data))

  tunnel.end()

  await pause(100)

  for (const peer of peers) peer.write(Buffer.from('late'))

  await pause(100)

  t.absent(tunnel.destroying, 'the tunnel is still up')
  t.alike(Buffer.concat(received), Buffer.from('late'), 'and what the peer sent still arrives')

  tunnel.destroy()
  agent.destroy()

  await closeServer(server)
})

// A wait that rounds down to nothing would read as an instruction not to reuse
// the connection, which is not what a wait under a second means.
test('a keep-alive wait under a second is not announced', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end('ok')))

  server.keepAliveTimeout = 900

  const raw = await rawUntil(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n',
    'ok'
  )

  t.ok(raw.includes('Connection: keep-alive\r\n'), 'the connection is kept')
  t.absent(raw.includes('Keep-Alive:'), 'but nothing is said of how long')

  await closeServer(server)
})

// The methods the constants name are the ones the parser accepts, so anything
// that reads them to decide what is routable reads the truth.
test('every method the constants name is one the server serves', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end('ok')))

  const port = server.address().port

  // A tunnel is handed over rather than answered, so it has nothing to say here.
  const methods = Object.values(http.constants.method).filter((method) => method !== 'CONNECT')

  const served = []

  for (const method of methods) {
    const raw = await rawBytes(
      port,
      `${method} / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
    )

    if (raw.startsWith('HTTP/1.1 200 OK\r\n')) served.push(method)
  }

  t.alike(served, methods, 'every method is served')
  t.alike(http.METHODS, Object.values(http.constants.method), 'and every one of them is exported')

  await closeServer(server)
})

// RFC 9112 asks that an empty line before the request line be ignored, since a
// peer that ends a message with a stray CRLF leaves one behind.
test('an empty line before the request line is ignored', async (t) => {
  const server = await listen(http.createServer((req, res) => res.end(req.url)))

  const raw = await rawBytes(
    server.address().port,
    '\r\n\r\nGET /ok HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.startsWith('HTTP/1.1 200 OK\r\n'), 'the request is served')
  t.ok(raw.endsWith('/ok'), 'and it is the one the peer sent')

  await closeServer(server)
})

// Zero turns a limit off, as it does for the timeouts, rather than leaving no
// room for a message at all.
test('a header size or count limit of zero is no limit', async (t) => {
  const server = await listen(
    http.createServer({ maxHeaderSize: 0, maxHeadersCount: 0 }, (req, res) =>
      res.end(Object.keys(req.headers).length.toString())
    )
  )

  const fields = Array.from({ length: 3000 }, (_, i) => `X-${i}: ${'a'.repeat(32)}\r\n`).join('')

  const raw = await rawBytes(
    server.address().port,
    `GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${fields}\r\n`
  )

  t.ok(raw.startsWith('HTTP/1.1 200 OK\r\n'), 'a head well past either default is served')
  t.ok(raw.endsWith('3002'), 'with every field it carried')

  await closeServer(server)
})

// A peer that is given credentials has to be given them in a form it can read,
// which is the header rather than the userinfo the URL carried them in.
test('credentials are sent as an authorization header', async (t) => {
  const seen = []

  const server = await listen(
    http.createServer((req, res) => {
      seen.push(req.headers.authorization)

      res.end('ok')
    })
  )

  const port = server.address().port

  await request(`http://user:pass@localhost:${port}/`)
  await request({ port, auth: 'user:pass' })
  await request({ port, auth: 'user:pass', headers: { Authorization: 'Bearer token' } })
  await request(`http://a%40b:p%3Ac@localhost:${port}/`)
  await request({ port })

  t.alike(
    seen,
    [
      'Basic dXNlcjpwYXNz',
      'Basic dXNlcjpwYXNz',
      // What the caller set for itself is left alone.
      'Bearer token',
      // The URL carries them percent encoded, but the header does not.
      `Basic ${Buffer.from('a@b:p:c').toString('base64')}`,
      undefined
    ],
    'the credentials reach the peer'
  )

  await closeServer(server)
})

// A request that arrived in full belongs to its consumer, however much of it
// they have got round to reading, so a connection going away afterwards must
// not take the body with it: `complete` says the whole of it is there.
test('a request that arrived whole outlives the connection', async (t) => {
  const sub = t.test()
  sub.plan(3)

  const server = await listen(
    http.createServer((req, res) => {
      // Answered before the body is read, and the peer asked for the connection
      // to be closed, so the socket goes away first.
      res.end('ok')

      setTimeout(() => {
        const chunks = []

        req
          .on('data', (data) => chunks.push(data))
          .on('error', () => sub.fail('the request should not fail'))
          .on('end', () => {
            sub.pass('the body ended')
            sub.is(req.complete, true, 'the message arrived whole')
            sub.alike(Buffer.concat(chunks), Buffer.from('hello'), 'and all of it is there')
          })
      }, 100)
    })
  )

  const peer = rawIdle(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 5\r\n\r\nhello'
  )

  await sub

  peer.socket.destroy()

  await closeServer(server)
})

test('a pooled socket is given up ahead of the wait the peer announced', async (t) => {
  const server = await rawServer(
    'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\nKeep-Alive: timeout=3\r\n\r\n'
  )

  const agent = new http.Agent({ keepAlive: true, timeout: 30000 })

  const result = await request({ port: server.address().port, agent })

  t.is(result.response.statusCode, 200, 'request answered')

  await pause(100)

  const pooled = [...agent.freeSockets]

  t.is(pooled.length, 1, 'the socket was pooled')
  t.is(pooled[0].timeout, 2000, 'kept for less time than the peer announced')

  agent.destroy()

  await closeServer(server)
})

// The peer takes the connection back so soon that a request handed one would be
// racing it, so there is nothing to be gained by keeping it.
test('a socket the peer keeps for too little time is not pooled', async (t) => {
  const server = await rawServer(
    'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\nKeep-Alive: timeout=1\r\n\r\n'
  )

  const agent = new http.Agent({ keepAlive: true })

  const result = await request({ port: server.address().port, agent })

  t.is(result.response.statusCode, 200, 'request answered')

  await pause(100)

  t.alike([...agent.freeSockets], [], 'nothing was pooled')

  agent.destroy()

  await closeServer(server)
})

test('flushed headers on a method that carries no body frame none', async (t) => {
  const seen = []

  const server = await listen(
    tcp.createServer((socket) => {
      socket
        .on('error', () => {})
        .on('data', (data) => {
          seen.push(data.toString())

          socket.write(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
        })
    })
  )

  const client = http.request({ port: server.address().port, agent: false })

  client.on('error', () => {})
  client.on('response', (res) => res.resume())

  client.flushHeaders()
  client.end()

  await pause(200)

  const sent = seen.join('')

  t.absent(sent.includes('Transfer-Encoding'), 'not chunked')
  t.absent(sent.includes('Content-Length'), 'no content length')

  await closeServer(server)
})

// The headers went out saying that nothing follows them, so there is nowhere
// left to frame a body: one written now would be read as the next request.
test('a body written after headers that framed none is refused', async (t) => {
  t.plan(2)

  const seen = []

  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {}).on('data', (data) => seen.push(data.toString()))
    })
  )

  const client = http.request({ port: server.address().port, agent: false })

  client.on('error', (err) => t.is(err.code, 'CONTENT_LENGTH_MISMATCH', 'the body was refused'))

  client.flushHeaders()
  client.end('body')

  await pause(200)

  t.absent(seen.join('').includes('body'), 'none of it went out')

  await closeServer(server)
})

test('a body that is not bytes is reported rather than sent', async (t) => {
  t.plan(3)

  const server = http.createServer((req, res) => {
    res.on('error', (err) => t.is(err.code, 'INVALID_BODY', 'the body was refused'))

    // Never thrown from underneath the caller, as nothing else that cannot be
    // sent is either.
    try {
      res.end(1234)

      t.pass('end did not throw')
    } catch {
      t.fail('end threw')
    }
  })

  await listen(server)

  const peer = rawIdle(server.address().port, 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')

  await pause(100)

  t.is(peer.response, '', 'nothing went out')

  peer.socket.destroy()

  await closeServer(server)
})

// A peer that opens a connection and then says nothing is one that never
// finished sending its request, which is what the headers deadline is there to
// catch, so it is told as much rather than merely hung up on.
test('a connection that says nothing at all times out', async (t) => {
  const server = await listen(
    http.createServer({ headersTimeout: 200 }, (req, res) => {
      t.fail('request should not be dispatched')
      res.end()
    })
  )

  const raw = await rawBytes(server.address().port, '')

  t.ok(raw.startsWith('HTTP/1.1 408 Request Timeout\r\n'), 'peer told why')
  t.ok(raw.includes('Connection: close\r\n'), 'connection close announced')

  await closeServer(server)
})

// The framing a message that carries no body drops is the framing that would
// leave the peer waiting. One that says the body is empty says something true,
// so it goes out as the caller wrote it, as Node.js sends it.
test('a content length of zero is kept on a method that carries no body', async (t) => {
  const seen = []

  const server = await listen(
    tcp.createServer((socket) => {
      socket
        .on('error', () => {})
        .on('data', (data) => {
          seen.push(data.toString())

          socket.write(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
        })
    })
  )

  const result = await request({
    port: server.address().port,
    agent: false,
    headers: { 'content-length': '0' }
  })

  t.absent(result.error)
  t.is(result.response.statusCode, 200, 'request understood')

  const sent = seen.join('')

  t.ok(sent.includes('Content-Length: 0\r\n'), 'the length it announced was kept')
  t.absent(sent.includes('Transfer-Encoding'), 'not chunked')

  await closeServer(server)
})

// The body is held to it like any other announced length, rather than to the
// nothing a request that dropped its framing may carry.
test('a body written against a kept content length of zero is refused', async (t) => {
  t.plan(2)

  const seen = []

  const server = await listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {}).on('data', (data) => seen.push(data.toString()))
    })
  )

  const client = http.request({
    port: server.address().port,
    agent: false,
    headers: { 'content-length': '0' }
  })

  client.on('error', (err) => t.is(err.code, 'CONTENT_LENGTH_MISMATCH', 'the body was refused'))

  client.end('body')

  await pause(200)

  t.absent(seen.join('').includes('body'), 'none of it went out')

  await closeServer(server)
})

// A length that the body which is not being sent could never match is still
// dropped, as a peer told to read one would read the next request instead.
test('a content length that no body will match is still dropped', async (t) => {
  const seen = []

  const server = await listen(
    tcp.createServer((socket) => {
      socket
        .on('error', () => {})
        .on('data', (data) => {
          seen.push(data.toString())

          socket.write(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
        })
    })
  )

  const result = await request({
    port: server.address().port,
    agent: false,
    headers: { 'content-length': '5' }
  })

  t.absent(result.error)
  t.absent(seen.join('').includes('Content-Length'), 'the length it announced was dropped')

  await closeServer(server)
})

function rawServer(response, opts = {}) {
  const { destroy = false, end = false } = opts

  return listen(
    tcp.createServer((socket) => {
      socket.on('error', () => {})

      socket.once('data', () => {
        socket.write(Buffer.from(response))

        if (end) socket.end()
        else if (destroy) setTimeout(() => socket.destroy(), 100)
      })
    })
  )
}

// Sends raw bytes and collects the raw response, so that what goes on the wire
// can be asserted on. Resolves once the peer closes, so the request should ask
// for the connection to be closed. Pass `on` and `send` to write more once a
// marker has been received, as an expectation requires.
function rawRequest(port, request, opts = {}) {
  const { on = null, send = null } = opts

  return new Promise((resolve, reject) => {
    const socket = tcp.createConnection(port, 'localhost')

    const chunks = []

    let sent = false

    socket
      .on('error', reject)
      .on('data', (data) => {
        chunks.push(data)

        if (on !== null && sent === false && Buffer.concat(chunks).toString().includes(on)) {
          sent = true
          socket.write(Buffer.from(send))
        }
      })
      .on('end', () => resolve(Buffer.concat(chunks).toString()))

    socket.write(Buffer.from(request))
  })
}

// Sends raw bytes and collects whatever comes back, resolving once the peer has
// gone away for whatever reason. Unlike `rawRequest`, a connection that is reset
// rather than closed is not an error, which is what a message that could not be
// framed safely looks like from the outside.
function rawBytes(port, request) {
  return new Promise((resolve) => {
    const socket = tcp.createConnection(port, 'localhost')

    const chunks = []

    const done = () => {
      socket.destroy()

      resolve(Buffer.concat(chunks).toString())
    }

    socket
      .on('error', done)
      .on('data', (data) => chunks.push(data))
      .on('end', done)
      .on('close', done)

    socket.write(Buffer.from(request))
  })
}

// Sends raw bytes and leaves the connection open afterwards, so that what this
// side does with a socket the peer will not close of its own accord can be
// asserted on. The caller closes it when it is done.
function rawIdle(port, request) {
  const socket = tcp.createConnection(port, 'localhost')

  const chunks = []

  socket.on('error', () => {}).on('data', (data) => chunks.push(data))

  socket.write(Buffer.from(request))

  return {
    socket,
    get response() {
      return Buffer.concat(chunks).toString()
    }
  }
}

// Sends raw bytes and collects whatever comes back until the given marker has
// been seen, for a connection the peer is expected to keep open.
function rawUntil(port, request, marker) {
  return new Promise((resolve, reject) => {
    const socket = tcp.createConnection(port, 'localhost')

    const chunks = []

    socket.on('error', reject).on('data', (data) => {
      chunks.push(data)

      const response = Buffer.concat(chunks).toString()

      if (response.includes(marker)) {
        socket.destroy()

        resolve(response)
      }
    })

    socket.write(Buffer.from(request))
  })
}

// Announces a body of the given size and writes it a chunk at a time, yielding
// between each so that the peer gets a chance to read. The socket is returned for
// the caller to close.
async function sendBody(port, total) {
  const socket = tcp.createConnection(port, 'localhost')

  socket.on('error', () => {}).on('data', () => {})

  socket.write(
    Buffer.from(`POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${total}\r\n\r\n`)
  )

  const chunk = Buffer.alloc(64 * 1024, 0x61)

  for (let sent = 0; sent < total; sent += chunk.byteLength) {
    socket.write(chunk)

    await pause(0)
  }

  return socket
}

// Sends a request and resolves once it is over, however it went, having collected
// whatever came back. The callback is handed the request to write and finish; a
// request with no body is finished here.
function request(opts, cb) {
  return new Promise((resolve) => {
    const client = http.request(opts)

    const result = { error: null, response: null }

    client.on('error', (err) => {
      result.error = err
    })

    client.on('response', (res) => {
      const r = (result.response = {
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        headers: res.headers,
        ended: false,
        chunks: []
      })

      res.on('data', (chunk) => r.chunks.push(chunk))
      res.on('end', () => {
        r.ended = true
      })
    })

    client.on('close', () => resolve(result))

    if (cb) cb(client)
    else client.end()
  })
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitFor(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve))
}

// Resolves to `false` if the promise it is given has not settled within the time
// allowed, so that a deadline that never fires reads as a failed assertion rather
// than hanging the run.
function within(ms, promise) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)

    timer.unref()

    promise.then(resolve, resolve)
  })
}

// Starts the server listening and resolves with it once it is up. Any further
// arguments are the ones `listen` itself takes.
function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.on('listening', done)
    server.on('error', done)

    server.listen(...(args.length > 0 ? args : [0]))

    function done(err) {
      server.removeListener('listening', done)
      server.removeListener('error', done)

      if (err) reject(err)
      else resolve(server)
    }
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve)

    for (const socket of server.connections) socket.destroy()
  })
}
