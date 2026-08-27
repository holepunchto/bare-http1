const test = require('brittle')
const tcp = require('bare-tcp')
const http = require('.')

test('basic', async (t) => {
  t.plan(24)

  const server = http.createServer()

  server
    .on('listening', () => t.pass('server listening'))
    .on('connection', (socket) => {
      t.ok(socket)

      socket.on('close', () => t.pass('server socket closed'))
    })
    .on('request', (req, res) => {
      t.ok(req)
      t.is(req.method, 'POST')
      t.is(req.url, '/something/?key1=value1&key2=value2&enabled')
      t.comment(req.headers.host)
      t.ok(req.socket)

      t.ok(res)
      t.is(res.statusCode, 200, 'default status code')
      t.ok(res.socket)
      t.is(res.req, req)
      t.is(res.headersSent, false, 'headers not flushed')

      res.statusCode = 201
      res.statusMessage = 'All good'

      t.is(req.socket, res.socket)

      res.setHeader('Content-Length', 12)
      t.is(res.getHeader('content-length'), 12)
      t.is(res.getHeader('Content-Length'), 12)

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
    .listen(0)

  await waitForServer(server)

  const req = await request(
    {
      method: 'POST',
      host: server.address().address,
      port: server.address().port,
      path: '/something/?key1=value1&key2=value2&enabled',
      headers: { 'Content-Length': 12 }
    },
    (req) => {
      req.write('body message')
      req.end()
    }
  )

  t.absent(req.error)
  t.is(req.response.statusCode, 201)
  t.is(req.response.statusMessage, 'All good')
  t.alike(Buffer.concat(req.response.chunks), Buffer.from('Hello world!'))

  server.close(() => t.pass('server closed'))
})

test('port already in use', async (t) => {
  t.plan(2)

  const server = http.createServer().listen(0)

  await waitForServer(server)

  http
    .createServer()
    .listen(server.address().port)
    .on('error', (err) => {
      t.is(err.code, 'EADDRINUSE')

      server.close(() => t.pass('server closed'))
    })
})

test('destroy request', async (t) => {
  t.plan(4)

  const server = http
    .createServer((req, res) => {
      req.on('close', () => t.pass('server request closed')).destroy()
    })
    .listen(0)

  await waitForServer(server)

  const req = await request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(req.response, 'client should not receive a response')
  t.ok(req.error, 'client errored')

  server.close(() => t.pass('server closed'))
})

test('request finishes once its body has been sent', async (t) => {
  t.plan(4)

  const server = http
    .createServer((req, res) => {
      req.resume().on('end', () => setTimeout(() => res.end('response'), 50))
    })
    .listen(0)

  await waitForServer(server)

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

  t.pass('server closed')
})

test('destroy request once its body has been sent', async (t) => {
  t.plan(3)

  const server = http
    .createServer((req, res) => {
      req.resume().on('end', () => setTimeout(() => res.end('response'), 200))
    })
    .listen(0)

  await waitForServer(server)

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

  t.pass('server closed')
})

test('destroy response', async (t) => {
  t.plan(5)

  const server = http
    .createServer((req, res) => {
      res.destroy()

      req.on('close', () => t.pass('server request closed'))
      res.on('close', () => t.pass('server response closed'))
    })
    .listen(0)

  await waitForServer(server)

  const req = await request({
    method: 'POST',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(req.response, 'client should not receive a response')
  t.ok(req.error, 'client errored')

  server.close(() => t.pass('server closed'))
})

test('destroy server socket', async (t) => {
  t.plan(4)

  const server = http
    .createServer((req, res) => {
      t.fail('server should not receive request')
    })
    .on('connection', (socket) => {
      socket.on('close', () => t.pass('server socket closed')).destroy()
    })
    .listen(0)

  await waitForServer(server)

  const req = await request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(req.response)
  t.ok(req.error, 'had error')

  server.close(() => t.pass('server closed'))
})

test('destroy client socket', async (t) => {
  t.plan(2)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      t.fail('server should not receive request')
    })
    .listen(0)

  await waitForServer(server)

  const req = http.request({ port: server.address().port })

  req.on('close', () => sub.pass('client socket closed'))

  req.socket.destroy()

  await sub

  server.close(() => t.pass('server closed'))
})

test('destroy partial GET request', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = http
    .createServer((req, res) => {
      req.on('close', () => sub.pass('request closed')).resume()
      res.on('close', () => sub.pass('response closed'))
    })
    .listen(0)

  await waitForServer(server)

  const client = tcp.createConnection(server.address().port)

  client.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')

  setTimeout(() => client.destroy(), 100)

  await sub

  server.close()
})

test('destroy partial POST request', async (t) => {
  const sub = t.test()
  sub.plan(2)

  const server = http
    .createServer((req, res) => {
      req.on('close', () => sub.pass('request closed')).resume()
      res.on('close', () => sub.pass('response closed'))
    })
    .listen(0)

  await waitForServer(server)

  const client = tcp.createConnection(server.address().port)

  client.write('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10000000\r\n\r\n')

  setTimeout(() => client.destroy(), 100)

  await sub

  server.close()
})

test('connection lost while the response body is arriving', async (t) => {
  t.plan(2)

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
      .on('aborted', () => sub.pass('response aborted'))
      .on('error', (err) => sub.is(err.code, 'CONNECTION_LOST', 'response failed'))
      .on('close', () => sub.pass('response closed'))
  })

  // The request was sent in full and answered, so it is not the half that
  // failed.
  req.on('error', () => t.fail('request should not fail'))

  req.end()

  await sub

  agent.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('connection lost before the response arrives', async (t) => {
  t.plan(3)

  // Takes the request and goes away without answering it.
  const server = tcp.createServer((socket) => {
    socket.on('error', () => {})

    socket.once('data', () => socket.end())
  })

  server.listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port })

  const req = http.request({ agent }, () => t.fail('no response expected'))

  // Nothing was answered, so the request is the half left outstanding.
  req.on('error', (err) => t.is(err.code, 'CONNECTION_LOST', 'request failed'))
  req.on('close', () => t.pass('request closed'))

  req.end()

  await waitFor(req, 'close')

  agent.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('connection lost after the response body has arrived', async (t) => {
  t.plan(2)

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

  t.pass('server closed')
})

test('write head', async (t) => {
  t.plan(7)

  const server = http
    .createServer((req, res) => {
      req.resume()
      res.writeHead(404)
      res.end()

      req.on('close', () => t.pass('server request closed'))
      res.on('close', () => t.pass('server response closed'))
    })
    .listen(0)

  await waitForServer(server)

  const req = await request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(req.error)
  t.is(req.response.statusCode, 404)
  t.alike(req.response.chunks, [])
  t.ok(req.response.ended)

  server.close(() => t.pass('server closed'))
})

test('write head with headers', async (t) => {
  t.plan(8)

  const server = http
    .createServer((req, res) => {
      req.resume()
      res.writeHead(404, { 'x-custom': 1234 })
      res.end()

      req.on('close', () => t.pass('server request closed'))
      res.on('close', () => t.pass('server response closed'))
    })
    .listen(0)

  await waitForServer(server)

  const req = await request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(req.error)
  t.is(req.response.statusCode, 404)
  t.alike(req.response.chunks, [], 'client should not receive data')
  t.ok(req.response.ended, 'client response ended')
  t.is(req.response.headers['x-custom'], '1234')

  server.close(() => t.pass('server closed'))
})

test('write head normalises header casing', async (t) => {
  t.plan(3)

  const server = http
    .createServer((req, res) => {
      res.setHeader('content-length', '2')
      // Sending both would be a framing error, so the second has to replace the
      // first rather than sit alongside it.
      res.writeHead(200, { 'Content-Length': '2' })
      res.end('ab')
    })
    .listen(0)

  await waitForServer(server)

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
  t.plan(3)

  const sub = t.test()
  sub.plan(4)

  const server = http
    .createServer((req, res) => {
      sub.is(res.headersSent, false, 'headers not sent before writing')

      res.write('chunk')

      // The headers went out with the write, so anything that would change them
      // is too late and has to say so rather than silently take effect.
      sub.is(res.headersSent, true, 'headers sent once written')
      sub.exception(() => res.setHeader('X-Late', '1'), /HEADERS_SENT/, 'setHeader throws')
      sub.exception(() => res.writeHead(500), /HEADERS_SENT/, 'writeHead throws')

      res.end()
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.ok(raw.startsWith('HTTP/1.1 200 OK\r\n'), 'status is the one that was sent')
  t.is(raw.includes('X-Late'), false, 'late header not sent')

  await closeServer(server)
})

test('request headers are readable whatever casing they were given in', (t) => {
  t.plan(4)

  const req = http.request({ agent: false, headers: { 'X-Custom': 'value' } })

  t.is(req.getHeader('x-custom'), 'value', 'readable in lower case')
  t.is(req.getHeader('X-Custom'), 'value', 'readable in the original casing')
  t.ok(req.hasHeader('X-Custom'), 'reported as present')
  t.alike(Object.keys(req.getHeaders()).sort(), ['host', 'x-custom'], 'stored in lower case')

  req.destroy()
})

test('chunked', async (t) => {
  t.plan(7)

  const server = http
    .createServer((req, res) => {
      const chunks = []

      req
        .on('data', (chunk) => chunks.push(chunk))
        .on('end', () => {
          t.alike(
            Buffer.concat(chunks),
            Buffer.from('request body part 1 + request body part 2'),
            'request body ended'
          )
        })

      res.write('response part 1 + ')
      setImmediate(() => {
        res.end('response part 2')
      })

      req.on('close', () => t.pass('server request closed'))
      res.on('close', () => t.pass('server response closed'))
    })
    .listen(0)

  await waitForServer(server)

  const req = await request(
    {
      method: 'POST',
      host: server.address().address,
      port: server.address().port,
      path: '/'
    },
    (req) => {
      req.write('request body part 1 + ')
      setImmediate(() => {
        req.end('request body part 2')
      })
    }
  )

  t.absent(req.error)
  t.is(req.response.statusCode, 200)
  t.alike(Buffer.concat(req.response.chunks), Buffer.from('response part 1 + response part 2'))

  server.close(() => t.pass('server closed'))
})

test('chunked request with trailer fields', async (t) => {
  t.plan(2)

  const server = http
    .createServer((req, res) => {
      const chunks = []

      req
        .on('data', (data) => chunks.push(data))
        .on('end', () => res.end(Buffer.concat(chunks)))
        .resume()
    })
    .listen(0)

  await waitForServer(server)

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
  t.plan(7)

  const server = http
    .createServer((req, res) => {
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
          setImmediate(() => {
            res.end(Buffer.alloc(2 * 1024 * 1024, 'efgh'))
          })
        })

      req.on('close', () => t.pass('server request closed'))
      res.on('close', () => t.pass('server response closed'))
    })
    .listen(0)

  await waitForServer(server)

  const req = await request(
    {
      method: 'POST',
      host: server.address().address,
      port: server.address().port,
      path: '/'
    },
    (req) => {
      req.write(Buffer.alloc(2 * 1024 * 1024, 'qwer'))
      setImmediate(() => {
        req.end(Buffer.alloc(2 * 1024 * 1024, 'asdf'))
      })
    }
  )

  t.is(req.response.statusCode, 200)
  t.ok(req.response.ended)
  t.alike(
    Buffer.concat(req.response.chunks),
    Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 'abcd'), Buffer.alloc(2 * 1024 * 1024, 'efgh')])
  )

  server.close(() => t.pass('server closed'))
})

test('request body is framed on a method that carries none by default', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      const chunks = []

      req
        .on('data', (data) => chunks.push(data))
        // An unframed body is not a body at all: the peer would read it as the
        // start of another request.
        .on('end', () => sub.alike(Buffer.concat(chunks), Buffer.from('body'), 'body received'))
        .resume()

      req.on('end', () => res.end('ok'))
    })
    .listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port })

  const result = await request({ agent, method: 'GET' }, (client) => client.end('body'))

  await sub

  t.is(result.response.statusCode, 200, 'request understood')

  agent.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('request without a body is not framed as chunked', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(2)

  const server = http
    .createServer((req, res) => {
      sub.is(req.headers['transfer-encoding'], undefined, 'not chunked')
      sub.is(req.headers['content-length'], undefined, 'no content length')

      res.end()
    })
    .listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port })

  const result = await request({ agent })

  await sub

  t.is(result.response.statusCode, 200, 'request understood')

  agent.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('response to HEAD has no body', async (t) => {
  t.plan(3)

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

  t.pass('response completed without a body')

  agent.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('response to HEAD does not consume the response after it', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(3)

  const server = http.createServer((req, res) => res.end('response')).listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const head = http.request({ agent, method: 'HEAD' }, (res) => {
    sub.is(res.getHeader('content-length'), '8', 'length a GET would have returned')

    res
      .on('data', () => sub.fail('no body expected'))
      .on('end', () => sub.pass('head response ended'))
      .resume()
  })

  const socket = head.socket

  head.on('close', () => {
    setImmediate(() => {
      // On the same socket, so a HEAD response that was read as having a body
      // would have swallowed this one whole.
      const get = http
        .request({ agent }, (res) => {
          t.is(get.socket, socket, 'socket reused')

          res.on('data', (data) => sub.alike(data, Buffer.from('response'), 'body received'))
        })
        .on('close', () => agent.destroy())

      get.end()
    })
  })

  head.end()

  await sub

  await closeServer(server)

  t.pass('server closed')
})

test('response delimited by the connection closing', async (t) => {
  t.plan(2)

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

  t.pass('server closed')
})

test('response with a status that carries no body', async (t) => {
  t.plan(3)

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

  t.pass('response completed without a body')

  agent.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('HTTP/1.0 request', async (t) => {
  t.plan(4)

  const sub = t.test()
  sub.plan(2)

  const server = http
    .createServer((req, res) => {
      sub.is(req.httpVersion, '1.0', 'version reported')
      sub.is(req.headers.connection, undefined, 'no connection header')

      // Written in two goes, so the body length is not known up front.
      res.write('hello ')
      res.end('world')
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawRequest(server.address().port, 'GET / HTTP/1.0\r\n\r\n')

  await sub

  // HTTP/1.0 has no chunked transfer encoding, so a body of unknown length can
  // only be delimited by closing the connection.
  t.is(raw.includes('Transfer-Encoding'), false, 'not chunked')
  t.ok(raw.includes('Connection: close\r\n'), 'connection close announced')
  t.ok(raw.endsWith('\r\n\r\nhello world'), 'body delimited by the close')

  await closeServer(server)
})

test('connection close is honoured whatever its casing', async (t) => {
  t.plan(2)

  const server = http.createServer((req, res) => res.end('response')).listen(0)

  await waitForServer(server)

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
  t.plan(4)

  const server = http
    .createServer((req, res) => {
      // The first request is answered slowest, so responses that are not held
      // back would go out the wrong way round and be read as each other's.
      setTimeout(() => res.end(req.url), req.url === '/first' ? 100 : 0)
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n' +
      'GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.includes('/first'), 'first request answered')
  t.ok(raw.includes('/second'), 'second request answered')
  t.ok(raw.indexOf('/first') < raw.indexOf('/second'), 'answered in request order')
  t.is(raw.split('HTTP/1.1 200 OK').length - 1, 2, 'one response each')

  await closeServer(server)
})

test('protocol negotiation', async (t) => {
  const sub = t.test()
  sub.plan(7)

  const server = http.createServer().listen(0)
  await waitForServer(server)

  server.on('upgrade', (req, socket, head) => {
    sub.alike(head, Buffer.from('request head'), 'server upgrade')

    req
      .on('end', () => sub.pass('server request ended'))
      .on('close', () => sub.pass('server request closed'))

    req
      .on('data', () => t.fail())
      .on('drain', () => t.fail())
      .on('error', () => t.fail())

    const handshake =
      'HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade\r\n' +
      '\r\n' +
      'server head'

    socket.end(handshake)
  })

  const req = http
    .request({
      port: server.address().port,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'weird-protocol'
      }
    })
    .end('request head')

  req.on('upgrade', (res, socket, head) => {
    sub.alike(head, Buffer.from('server head'), 'client upgrade')

    req.on('close', () => sub.pass('client request closed'))

    res
      .on('close', () => sub.pass('client response closed'))
      .on('end', () => sub.pass('client response ended'))

    res
      .on('data', () => t.fail())
      .on('drain', () => t.fail())
      .on('error', () => t.fail())

    socket.end()
  })

  await sub

  server.close()
})

test('close connection if missing upgrade handler', async (t) => {
  const sub = t.test()
  sub.plan(1)

  const server = http.createServer().listen(0)
  await waitForServer(server)

  server.on('upgrade', (req, socket, head) => {
    const handshake =
      'HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade\r\n' +
      '\r\n'

    socket.end(handshake)
  })

  const req = http
    .request({
      port: server.address().port,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'weird-protocol'
      }
    })
    .end()

  req.on('close', () => sub.pass('connection closed'))

  await sub

  server.close()
})

test('expect 100-continue is answered automatically', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      const chunks = []

      req
        .on('data', (data) => chunks.push(data))
        .on('end', () => {
          sub.alike(Buffer.concat(chunks), Buffer.from('hello'), 'body received')
          res.end('done')
        })
        .resume()
    })
    .listen(0)

  await waitForServer(server)

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
  t.plan(2)

  const server = http.createServer()

  // A handler takes the decision over, and may turn the request down before its
  // body is ever sent.
  server.on('checkContinue', (req, res) => {
    res.statusCode = 417
    res.end('nope')
  })

  server.listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n' +
      'Expect: 100-continue\r\nContent-Length: 5\r\n\r\n'
  )

  t.is(raw.includes('100 Continue'), false, 'continue not sent')
  t.ok(raw.startsWith('HTTP/1.1 417 Expectation Failed\r\n'), 'request turned down')

  await closeServer(server)
})

test('interim response is reported separately from the response', async (t) => {
  t.plan(3)

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

  t.pass('both responses reported')

  agent.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('GET request', async (t) => {
  t.plan(6)

  const sub = t.test()
  sub.plan(2)

  const server = http
    .createServer((req, res) => {
      t.is(req.url, '/path')
      t.is(req.method, 'GET')

      res.end('response')
    })
    .listen(0)

  await waitForServer(server)

  const url = `http://localhost:${server.address().port}/path`

  http.get(url, (res) => {
    res.on('data', (data) => sub.alike(data, Buffer.from('response')))
  })

  http.get(new URL(url), (res) => {
    res.on('data', (data) => sub.alike(data, Buffer.from('response')))
  })

  await sub

  server.close(() => t.pass('server closed'))
})

test('custom request headers', async (t) => {
  t.plan(2)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      res.end()
      sub.is(req.headers['custom-header'], 'value')
    })
    .listen(0)

  await waitForServer(server)

  http.request({ port: server.address().port, headers: { 'custom-header': 'value' } }).end()

  await sub

  server.close(() => t.pass('server closed'))
})

test('client request timeout', async (t) => {
  t.plan(2)

  const sub = t.test()
  sub.plan(2)

  const server = http
    .createServer(async (req, res) => {
      await sub

      res.end()
    })
    .listen(0)

  await waitForServer(server)

  const req = http.request({ port: server.address().port }).end()

  req.on('timeout', () => sub.pass('timeout')).setTimeout(100, () => sub.pass('callback invoked'))

  await sub

  server.close(() => t.pass('server closed'))
})

test('server timeout', async (t) => {
  t.plan(2)

  const sub = t.test()
  sub.plan(3)

  const server = http.createServer((req, res) => res.end()).listen(0)

  server
    .on('timeout', () => sub.pass('timeout'))
    .setTimeout(100, () => sub.pass('callback invoked'))

  sub.is(server.timeout, 100)

  await waitForServer(server)

  const req = http.request({ port: server.address().port })

  await sub

  req.on('close', () => server.close(() => t.pass('server closed'))).end()
})

test('server timeout, no handler', async (t) => {
  t.plan(2)

  const server = http.createServer().listen(0).setTimeout(100)

  await waitForServer(server)

  const req = http.request({ port: server.address().port })

  req.on('error', (err) => {
    t.pass(err.message)

    server.close(() => t.pass('server closed'))
  })
})

test('server timeout, handler', async (t) => {
  t.plan(2)

  const server = http
    .createServer((req, res) => {
      res.on('timeout', () => {
        t.pass('response timeout')

        res.end()
      })
    })
    .listen(0)
    .setTimeout(100)

  await waitForServer(server)

  const req = http.request({ port: server.address().port }).end()

  req.on('close', () => server.close(() => t.pass('server closed'))).end()
})

test('server response timeout', async (t) => {
  t.plan(2)

  const sub = t.test()
  sub.plan(2)

  const server = http
    .createServer(async (req, res) => {
      res
        .on('timeout', () => sub.pass('timeout'))
        .setTimeout(100, () => sub.pass('callback invoked'))

      await sub

      res.end()
    })
    .listen(0)

  await waitForServer(server)

  const req = http.request({ port: server.address().port }).end()

  await sub

  req.on('close', () => server.close(() => t.pass('server closed'))).end()
})

test('cancel timeouts when has upgrade event handled', async (t) => {
  const server = http
    .createServer()
    .on('upgrade', (req, socket, head) => {
      const handshake =
        'HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
        'Upgrade: weird-protocol\r\n' +
        'Connection: Upgrade\r\n' +
        '\r\n'

      socket.end(handshake)
    })
    .on('timeout', () => t.fail('server timeout'))
    .setTimeout(100, () => t.fail('server callback invoked'))
    .listen(0)

  await waitForServer(server)

  const req = http
    .request({
      port: server.address().port,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'weird-protocol'
      }
    })

    .on('timeout', () => t.fail('client timeout'))
    .setTimeout(100, () => t.fail('client callback invoked'))
    .end()

  let upgradedSocket

  req.on('upgrade', (res, socket) => {
    upgradedSocket = socket
  })

  setTimeout(() => {
    t.end()

    upgradedSocket.end()
    server.close()
  }, 400)
})

test('socket reuse', async (t) => {
  t.plan(2)

  const sub = t.test()
  sub.plan(3)

  const server = http.createServer((req, res) => res.end('response')).listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  let socket

  let req = http
    .request({ agent }, (res) => {
      socket = req.socket

      res.on('data', (data) => sub.alike(data, Buffer.from('response')))
    })
    .on('close', () => {
      setImmediate(() => {
        req = http
          .request({ agent }, (res) => {
            sub.ok(req.socket === socket, 'socket reused')

            res.on('data', (data) => sub.alike(data, Buffer.from('response')))
          })
          .on('close', () => {
            agent.destroy()
          })
          .end()
      })
    })
    .end()

  await sub

  server.close(() => t.pass('server closed'))
})

test('socket reuse, destroy first response', async (t) => {
  t.plan(2)

  const sub = t.test()
  sub.plan(3)

  const server = http.createServer((req, res) => res.end('response')).listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  let socket

  let req = http
    .request({ agent }, (res) => {
      socket = req.socket

      res.on('close', () => sub.pass('response closed')).destroy()
    })
    .on('close', () => {
      setImmediate(() => {
        req = http
          .request({ agent }, (res) => {
            sub.not(req.socket, socket, 'socket not reused')

            res.on('data', (data) => sub.alike(data, Buffer.from('response')))
          })
          .on('close', () => {
            agent.destroy()
          })
          .end()
      })
    })
    .end()

  await sub

  server.close(() => t.pass('server closed'))
})

test('socket reuse, destroy pooled socket', async (t) => {
  t.plan(3)

  const server = http.createServer((req, res) => res.end('response')).listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const first = http.request({ agent }, (res) => res.resume())

  const socket = first.socket

  first.end()

  await new Promise((resolve) => first.on('close', resolve))

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

  t.pass('server closed')
})

test('socket reuse, server closes the connection', async (t) => {
  t.plan(3)

  const server = http
    .createServer((req, res) => {
      // The peer is bowing out, so its socket must not be picked up for the
      // next request however keen the agent is to keep it.
      res.setHeader('Connection', 'close')
      res.end('response')
    })
    .listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const first = http.request({ agent }, (res) => res.resume())

  const socket = first.socket

  first.end()

  await new Promise((resolve) => first.on('close', resolve))

  const sub = t.test('second request')
  sub.plan(1)

  const second = http.request({ agent }, (res) => {
    res.on('data', (data) => sub.alike(data, Buffer.from('response')))
  })

  t.not(second.socket, socket, 'socket not reused')

  second.on('close', () => agent.destroy()).end()

  await sub

  await closeServer(server)

  t.pass('server closed')
})

test('socket reuse, socket closes after timeout', async (t) => {
  t.plan(2)

  const sub = t.test()
  sub.plan(2)

  const server = http.createServer((req, res) => res.end('response')).listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port, keepAlive: true, timeout: 500 })

  const req = http
    .request({ agent }, (res) => {
      res.on('close', () => sub.pass('response closed')).resume()

      req.socket.on('close', () => sub.pass('socket closed'))
    })
    .end()

  await sub

  server.close(() => t.pass('server closed'))
})

test('close server while a response is in flight', async (t) => {
  t.plan(4)

  const server = http.createServer((req, res) => {
    // Closed from inside the handler, which must not cut short the response the
    // handler is about to write.
    server.close(() => t.pass('server closed'))

    setTimeout(() => res.end('late response'), 100)
  })

  server.listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port })

  const result = await request({ agent })

  t.is(result.error, null, 'no error')
  t.is(result.response.statusCode, 200, 'response received')
  t.alike(Buffer.concat(result.response.chunks), Buffer.from('late response'), 'body intact')

  agent.destroy()
})

test('close server while a response is in flight, closed from outside', async (t) => {
  t.plan(4)

  const server = http.createServer((req, res) => {
    setTimeout(() => res.end('late response'), 200)
  })

  server.listen(0)

  await waitForServer(server)

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
  t.plan(4)

  const sub = t.test()
  sub.plan(1)

  // Taken but never answered, so the exchange never finishes on its own.
  const server = http.createServer(() => sub.pass('request received')).listen(0)

  await waitForServer(server)

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

  t.pass('server closed')

  agent.destroy()
})

test('close server with an idle keep-alive connection', async (t) => {
  t.plan(3)

  const server = http.createServer((req, res) => res.end('response')).listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const result = await request({ agent })

  t.is(result.response.statusCode, 200, 'response received')

  // Nothing is in flight any more, so closing must not wait on the pooled
  // connection.
  server.close(() => t.pass('server closed'))

  agent.destroy()

  t.pass('close did not hang')
})

test('reuse port after closing server', async (t) => {
  t.plan(2)

  let server
  let sub

  server = http.createServer((req, res) => res.end()).listen(0)

  await waitForServer(server)

  const { port } = server.address()

  await request({ port })

  sub = t.test('first server close')
  sub.plan(1)

  server.close(() => sub.pass())

  await sub

  server = http.createServer((req, res) => res.end()).listen(port)
  await waitForServer(server)

  await request({ port })

  sub = t.test('second server close')
  sub.plan(1)

  server.close(() => sub.pass())

  await sub
})

test('socket closes when the agent does not keep it alive', async (t) => {
  t.plan(4)

  // A raw server, as it must leave its own side of the connection open when the
  // client half-closes.
  const server = await halfOpenServer()

  const agent = new http.Agent({ port: server.address().port, keepAlive: false })

  const req = http.request({ agent }, (res) => res.resume())

  const closed = new Promise((resolve) => req.socket.on('close', resolve))

  req.end()

  await closed

  t.pass('socket closed')
  t.is([...agent.sockets].length, 0, 'no sockets left')
  t.is([...agent.freeSockets].length, 0, 'no free sockets left')

  await closeServer(server)

  t.pass('server closed')
})

test('socket closes when the peer half-closes it', async (t) => {
  t.plan(4)

  const server = await halfOpenServer({ end: true })

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  // The response is deliberately left unconsumed, so the socket is still in use
  // by the time the peer half-closes it.
  const req = http.request({ agent })

  const closed = new Promise((resolve) => req.socket.on('close', resolve))

  req.end()

  await closed

  t.pass('socket closed')
  t.is([...agent.sockets].length, 0, 'no sockets left')
  t.is([...agent.freeSockets].length, 0, 'no free sockets left')

  await closeServer(server)

  t.pass('server closed')
})

test('reused socket is tracked once', async (t) => {
  t.plan(7)

  const server = http.createServer((req, res) => res.end('response')).listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  let socket = null

  for (let i = 0; i < 3; i++) {
    const responded = new Promise((resolve) => {
      const req = http.request({ agent }, (res) => {
        res.on('close', resolve).resume()
      })

      if (socket === null) socket = req.socket
      else t.is(req.socket, socket, 'socket reused')

      req.end()
    })

    await responded

    t.is([...agent.sockets].length, 1, 'socket tracked once')
  }

  const closed = new Promise((resolve) => socket.on('close', resolve))

  agent.destroy()

  await closed

  t.is([...agent.sockets].length, 0, 'no sockets left')

  server.close(() => t.pass('server closed'))
})

test('suspend agent', async (t) => {
  t.plan(8)

  const sub = t.test()
  sub.plan(1)

  const server = http.createServer((req, res) => res.end()).listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port })

  const req = http.request({ agent }).end()

  req.socket.on('close', () => sub.pass('socket closed'))

  agent.suspend()

  t.is(agent.suspended, true)
  t.execution(agent.resumed)

  await sub

  await t.exception(() => http.request({ agent }), /AGENT_SUSPENDED/)

  agent.resume()

  t.is(agent.suspended, false)
  t.absent(agent.resumed)

  http
    .request({ agent }, () => {
      t.pass()

      server.close(() => t.pass('server closed'))
    })
    .end()
})

test('statusCode rejects anything that is not a status code', (t) => {
  t.plan(4)

  const res = new http.ServerResponse(null, new http.IncomingMessage())

  // A status code is written straight into the status line, so a string could
  // otherwise carry a whole response of its own.
  t.exception(() => {
    res.statusCode = '200 OK\r\nX-Injected: yes'
  }, /INVALID_STATUS_CODE/)

  t.exception(() => {
    res.statusCode = 99
  }, /INVALID_STATUS_CODE/)

  t.exception(() => {
    res.statusCode = 1000
  }, /INVALID_STATUS_CODE/)

  t.exception(() => {
    res.statusCode = 200.5
  }, /INVALID_STATUS_CODE/)
})

test('writeHead rejects anything that is not a status code', (t) => {
  t.plan(2)

  const res = new http.ServerResponse(null, new http.IncomingMessage())

  t.exception(() => res.writeHead('200 OK\r\nX-Injected: yes'), /INVALID_STATUS_CODE/)
  t.exception(() => res.writeHead(99), /INVALID_STATUS_CODE/)
})

test('unknown status code gets a placeholder reason phrase', async (t) => {
  t.plan(1)

  const server = http
    .createServer((req, res) => {
      res.statusCode = 599
      res.end()
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.startsWith('HTTP/1.1 599 unknown\r\n'), 'reason phrase filled in')

  await closeServer(server)
})

test('malformed request is reported as a client error', async (t) => {
  t.plan(2)

  const sub = t.test()
  sub.plan(1)

  const server = http.createServer((req, res) => res.end())

  // A handler takes the error on, so the server does not answer it itself.
  server.on('clientError', (err, socket) => {
    sub.ok(err.code, 'client error reported')

    socket.destroy()
  })

  server.listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nBad Header: value\r\n\r\n'
  )

  await sub

  t.is(raw, '', 'handler answered it instead')

  await closeServer(server)
})

test('malformed request is answered with 400 when unhandled', async (t) => {
  t.plan(1)

  const server = http.createServer((req, res) => res.end()).listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nBad Header: value\r\n\r\n'
  )

  t.ok(raw.startsWith('HTTP/1.1 400 Bad Request\r\n'), 'client told its request was bad')

  await closeServer(server)
})

test('request truncated by the peer', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(3)

  const server = http.createServer((req) => {
    req
      .on('end', () => sub.fail('the body never completed'))
      // Reported as an abort rather than an error, so that a client dropping a
      // connection cannot take the server down with it.
      .on('aborted', () => sub.pass('request aborted'))
      .on('close', () => sub.pass('request closed'))
      .resume()
  })

  server.on('clientError', (err) => sub.ok(err, 'client error reported'))

  server.listen(0)

  await waitForServer(server)

  const socket = tcp.createConnection(server.address().port, 'localhost')

  socket.on('error', () => {})

  // Promises ten bytes, sends four, then stops writing.
  socket.write(Buffer.from('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nabcd'))
  socket.end()

  await sub

  t.pass('truncation surfaced')

  socket.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('peer stops writing after a complete request', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http.createServer((req, res) => {
    req.on('end', () => sub.pass('request completed')).resume()

    res.end('response')
  })

  // Half-closing after a whole request is not a truncation.
  server.on('clientError', () => t.fail('no client error expected'))

  server.listen(0)

  await waitForServer(server)

  const socket = tcp.createConnection(server.address().port, 'localhost')

  socket.on('error', () => {})
  socket.end(Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'))

  await sub

  t.pass('no truncation reported')

  socket.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('setTimeout after the message has ended', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      req.resume().on('end', () => {
        // The message has let go of its socket by now, which is no reason to
        // throw at the caller.
        sub.execution(() => req.setTimeout(1000), 'setTimeout does not throw')

        res.end()
      })
    })
    .listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port })

  const result = await request({ agent, method: 'POST' }, (client) => client.end('body'))

  await sub

  t.is(result.response.statusCode, 200, 'response received')

  agent.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('response carries a date, which can be replaced', async (t) => {
  t.plan(2)

  const server = http
    .createServer((req, res) => {
      if (req.url === '/own') res.setHeader('Date', 'whenever')

      res.end()
    })
    .listen(0)

  await waitForServer(server)

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

test('setHeader rejects CRLF in header value', (t) => {
  t.plan(1)

  const server = http.createServer((req, res) => {
    t.exception(
      () => res.setHeader('x-evil', 'value\r\nInjected-Header: pwned'),
      /INVALID_HEADER_VALUE/
    )
    res.end()
  })

  server.listen(0, async () => {
    await request({ port: server.address().port, path: '/' })
    server.close()
  })
})

test('setHeader rejects invalid characters in header name', (t) => {
  t.plan(1)

  const server = http.createServer((req, res) => {
    t.exception(() => res.setHeader('bad header', 'value'), /INVALID_HEADER_NAME/)
    res.end()
  })

  server.listen(0, async () => {
    await request({ port: server.address().port, path: '/' })
    server.close()
  })
})

test('statusMessage setter rejects CRLF', (t) => {
  t.plan(1)

  const server = http.createServer((req, res) => {
    t.exception(() => {
      res.statusMessage = 'OK\r\nInjected-Header: pwned'
    }, /INVALID_HEADER_VALUE/)
    res.end()
  })

  server.listen(0, async () => {
    await request({ port: server.address().port, path: '/' })
    server.close()
  })
})

test('writeHead rejects CRLF in status message and header values', (t) => {
  t.plan(2)

  const server = http.createServer((req, res) => {
    t.exception(() => res.writeHead(200, 'OK\r\nInjected: x'), /INVALID_HEADER_VALUE/)
    t.exception(
      () => res.writeHead(200, { 'x-evil': 'value\r\nInjected: x' }),
      /INVALID_HEADER_VALUE/
    )
    res.end()
  })

  server.listen(0, async () => {
    await request({ port: server.address().port, path: '/' })
    server.close()
  })
})

test('client request rejects CRLF in header value', (t) => {
  t.plan(1)

  t.exception(
    () =>
      new http.ClientRequest({
        agent: false,
        path: '/',
        headers: { 'x-evil': 'value\r\nInjected-Header: pwned' }
      }),
    /INVALID_HEADER_VALUE/
  )
})

test('client request rejects CRLF in path', (t) => {
  t.plan(1)

  t.exception(
    () =>
      new http.ClientRequest({
        agent: false,
        path: '/evil\r\nGET /admin HTTP/1.1'
      }),
    /INVALID_HEADER_VALUE/
  )
})

test('client request rejects invalid method', (t) => {
  t.plan(1)

  t.exception(
    () =>
      new http.ClientRequest({
        agent: false,
        method: 'GET\r\nEvil',
        path: '/'
      }),
    /INVALID_HEADER_NAME/
  )
})

// A raw HTTP server that responds to any request and then leaves its side of
// the connection open, half-closing it first if `end` is set. Used to keep a
// connection in a state that `http.Server` would tear down on its own.
async function halfOpenServer(opts = {}) {
  const { end = false } = opts

  const server = tcp.createServer((socket) => {
    socket.on('error', () => {})

    socket.once('data', () => {
      socket.write(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nresponse'))

      if (end) socket.end()
    })
  })

  server.listen(0)

  await waitForServer(server)

  return server
}

// A raw server that replies with the given bytes, so that responses the library
// would not produce itself can be tested. Optionally drops the connection right
// after replying.
async function rawServer(response, opts = {}) {
  const { destroy = false, end = false } = opts

  const server = tcp.createServer((socket) => {
    socket.on('error', () => {})

    socket.once('data', () => {
      socket.write(Buffer.from(response))

      if (end) socket.end()
      else if (destroy) setTimeout(() => socket.destroy(), 100)
    })
  })

  server.listen(0)

  await waitForServer(server)

  return server
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

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitFor(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve))
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve)

    for (const socket of server.connections) socket.destroy()
  })
}

function waitForServer(server) {
  return new Promise((resolve, reject) => {
    server.on('listening', done)
    server.on('error', done)

    function done(error) {
      server.removeListener('listening', done)
      server.removeListener('error', done)
      error ? reject(error) : resolve()
    }
  })
}

function request(opts, cb) {
  return new Promise((resolve) => {
    const client = http.request(opts)

    const result = { statusCode: 0, error: null, response: null }

    client.on('error', (err) => {
      result.error = err.message
    })

    client.on('response', (res) => {
      const r = (result.response = {
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        headers: res.headers,
        ended: false,
        chunks: []
      })
      r.statusCode = res.statusCode
      res.on('data', (chunk) => r.chunks.push(chunk))
      res.on('end', () => {
        r.ended = true
      })
    })

    client.on('close', () => {
      if (result.response) {
        result.response.chunks = result.response.chunks.map((c) => Buffer.from(c, 'hex'))
      }

      resolve(result)
    })

    if (cb) {
      cb(client)
    } else {
      client.end()
    }
  })
}
