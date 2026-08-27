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

// A body that does not match what the peer was told to read runs over into the
// next message on the connection, so it never reaches the socket at all.
test('response body longer than its content length is not sent', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      res.on('error', (err) =>
        sub.is(err.code, 'CONTENT_LENGTH_MISMATCH', 'reported on the response')
      )

      res.setHeader('Content-Length', '2')
      res.end('hello world')
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.is(raw, '', 'nothing sent')

  await closeServer(server)

  t.pass('server closed')
})

test('response body shorter than its content length is not sent', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      res.on('error', (err) =>
        sub.is(err.code, 'CONTENT_LENGTH_MISMATCH', 'reported on the response')
      )

      res.setHeader('Content-Length', '20')
      res.end('short')
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.is(raw, '', 'nothing sent')

  await closeServer(server)

  t.pass('server closed')
})

// The mismatch that `String#length` gives for anything outside ASCII is the
// easiest one to write by accident.
test('content length is counted in bytes, not characters', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const body = 'café ❤' // 6 characters, 9 bytes

  const server = http
    .createServer((req, res) => {
      res.on('error', (err) =>
        sub.is(err.code, 'CONTENT_LENGTH_MISMATCH', 'reported on the response')
      )

      res.setHeader('Content-Length', body.length.toString())
      res.end(body)
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.is(raw, '', 'nothing sent')

  await closeServer(server)

  t.pass('server closed')
})

// A content length the peer would read as a different number, or not as a
// number at all, leaves the body unframed.
test('content length that is not a count of bytes is refused', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      res.on('error', (err) =>
        sub.is(err.code, 'INVALID_CONTENT_LENGTH', 'reported on the response')
      )

      res.setHeader('Content-Length', '2 ')
      res.end('hi')
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.is(raw, '', 'nothing sent')

  await closeServer(server)

  t.pass('server closed')
})

// A zero length chunk is what terminates a chunked body, so writing one before
// the end would finish the response early and turn the rest into a second one.
test('zero length write does not terminate a chunked body', async (t) => {
  t.plan(3)

  const server = http
    .createServer((req, res) => {
      res.write('aaa')
      res.write(Buffer.alloc(0))
      res.write('')
      res.end('bbb')
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.includes('Transfer-Encoding: chunked\r\n'), 'chunked')
  t.ok(raw.endsWith('\r\n\r\n3\r\naaa\r\n3\r\nbbb\r\n0\r\n\r\n'), 'one body, terminated once')

  await closeServer(server)

  t.pass('server closed')
})

test('zero length write does not split a response in two', async (t) => {
  t.plan(3)

  const server = http
    .createServer((req, res) => {
      if (req.url === '/first') {
        res.write('aa')
        res.write(Buffer.alloc(0))
        res.end('bb')
      } else {
        res.end('second')
      }
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n' +
      'GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.is(raw.split('HTTP/1.1 200 OK').length - 1, 2, 'one response each')
  t.ok(raw.includes('2\r\naa\r\n2\r\nbb\r\n0\r\n\r\nHTTP/1.1 200 OK'), 'bodies not split')

  await closeServer(server)

  t.pass('server closed')
})

// A peer reads no body for these, so anything written for one would be read as
// the start of the next response.
test('status that carries no body is sent without one', async (t) => {
  t.plan(4)

  const server = http
    .createServer((req, res) => {
      res.statusCode = Number(req.url.slice(1))
      res.end('injected')
    })
    .listen(0)

  await waitForServer(server)

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

  t.pass('server closed')
})

test('status that carries no body does not split a response in two', async (t) => {
  t.plan(3)

  const server = http
    .createServer((req, res) => {
      if (req.url === '/first') {
        res.statusCode = 204
        res.end('INJECTED')
      } else {
        res.end('second')
      }
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n' +
      'GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.is(raw.includes('INJECTED'), false, 'nothing written for the 204')
  t.is(raw.split(/HTTP\/1\.1 \d\d\d/).length - 1, 2, 'one status line each')

  await closeServer(server)

  t.pass('server closed')
})

// A 304 stands in for a response that would have had a body, so it may carry
// the length of the one it is replacing.
test('a 304 keeps a content length that was set for it', async (t) => {
  t.plan(3)

  const server = http
    .createServer((req, res) => {
      res.statusCode = 304
      res.setHeader('Content-Length', '100')
      res.end()
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.includes('Content-Length: 100\r\n'), 'length kept')
  t.is(raw.includes('Transfer-Encoding'), false, 'not chunked')

  await closeServer(server)

  t.pass('server closed')
})

// Sending both framing headers is the classic way to have two peers disagree
// about where a message ends.
test('transfer encoding set by the caller is announced once and alone', async (t) => {
  t.plan(4)

  const server = http
    .createServer((req, res) => {
      res.setHeader('Transfer-Encoding', 'chunked')

      if (req.url === '/split') {
        res.write('hel')
        res.end('lo')
      } else {
        res.end('hello')
      }
    })
    .listen(0)

  await waitForServer(server)

  for (const path of ['/one', '/split']) {
    const raw = await rawRequest(
      server.address().port,
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
    )

    t.is(raw.split('Transfer-Encoding: chunked\r\n').length - 1, 1, `announced once for ${path}`)
    t.is(raw.includes('Content-Length'), false, `no content length for ${path}`)
  }

  await closeServer(server)
})

test('transfer encoding that is not chunked is refused', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      res.on('error', (err) =>
        sub.is(err.code, 'INVALID_TRANSFER_ENCODING', 'reported on the response')
      )

      res.setHeader('Transfer-Encoding', 'gzip')
      res.end('hello')
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.is(raw, '', 'nothing sent')

  await closeServer(server)

  t.pass('server closed')
})

// The same framing hazards apply to a request, where the peer reading the
// surplus is a server that will act on it.
test('request body longer than its content length is not sent', async (t) => {
  t.plan(3)

  const server = tcp.createServer((socket) => {
    socket.on('error', () => {})
    socket.on('data', () => t.fail('nothing should be sent'))
  })

  server.listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port })

  const req = http.request({ agent, method: 'POST' })

  req.setHeader('Content-Length', '2')
  req.end('SMUGGLED BODY')

  const err = await waitFor(req, 'error')

  t.is(err.code, 'CONTENT_LENGTH_MISMATCH', 'reported on the request')

  agent.destroy()

  await closeServer(server)

  t.pass('server closed')

  await pause(100)

  t.pass('nothing reached the peer')
})

test('request that carries no body drops the framing it announced', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(2)

  const server = http
    .createServer((req, res) => {
      sub.is(req.headers['content-length'], undefined, 'no content length')
      sub.is(req.headers['transfer-encoding'], undefined, 'not chunked')

      res.end('ok')
    })
    .listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port })

  // A server told to read a body that never arrives reads the next request as
  // one instead.
  const result = await request({ agent, headers: { 'content-length': '5' } })

  await sub

  t.is(result.response.statusCode, 200, 'request understood')

  agent.destroy()

  await closeServer(server)

  t.pass('server closed')
})

// A list cannot be folded onto one line when its own values may contain the
// separator, which is why `Set-Cookie` may only ever appear once per line.
test('a list header value is sent as one field per element', async (t) => {
  t.plan(3)

  const server = http
    .createServer((req, res) => {
      res.setHeader('Set-Cookie', ['a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT', 'b=2'])
      res.end('ok')
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(
    raw.includes('Set-Cookie: a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT\r\n'),
    'first cookie intact'
  )
  t.ok(raw.includes('Set-Cookie: b=2\r\n'), 'second cookie on its own line')

  await closeServer(server)

  t.pass('server closed')
})

// And what goes out one field per element has to come back one element per
// field, or a consumer would have to split on a separator that the values it is
// splitting are allowed to contain.
test('a list header value is received as it was sent', async (t) => {
  t.plan(3)

  const cookies = ['a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT', 'b=2']

  const server = http
    .createServer((req, res) => {
      res.setHeader('Set-Cookie', cookies)
      res.end('ok')
    })
    .listen(0)

  await waitForServer(server)

  const { response } = await request({ port: server.address().port })

  t.ok(Array.isArray(response.headers['set-cookie']), 'received as a list')
  t.alike(response.headers['set-cookie'], cookies, 'every cookie intact')

  await closeServer(server)

  t.pass('server closed')
})

// `Cookie` is the exception: it may only appear once, and its list separator is
// `; ` rather than a comma.
test('a cookie list header value is folded onto one line', async (t) => {
  t.plan(2)

  const server = http
    .createServer((req, res) => {
      res.setHeader('Cookie', ['a=1', 'b=2'])
      res.end('ok')
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  t.ok(raw.includes('Cookie: a=1; b=2\r\n'), 'folded with the right separator')

  await closeServer(server)

  t.pass('server closed')
})

// A header bag that inherits from `Object.prototype` answers for names nobody
// set, and `__proto__` changes the bag rather than being stored in it.
test('header lookups ignore anything not actually set', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    t.is(res.hasHeader(name), false, `${name} is not a header`)
    t.is(res.getHeader(name), undefined, `${name} has no value`)
  }

  const req = new http.IncomingMessage(null, { headers: { 'x-real': 'yes' } })

  t.is(req.hasHeader('constructor'), false, 'not a header on a request either')
  t.is(req.hasHeader('x-real'), true, 'a header that was set is found')
})

test('header name that would reach the prototype is refused', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  t.exception(() => res.setHeader('__proto__', { 'content-length': '999' }), /INVALID_HEADER_NAME/)
  t.exception(() => res.setHeader('__PROTO__', 'x'), /INVALID_HEADER_NAME/)

  // The framing decision reads the header bag, so a bag whose prototype had
  // been replaced would leave the response unframed altogether.
  t.is(res.hasHeader('content-length'), false, 'nothing was stored')
})

test('incoming header name that would reach the prototype is refused', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      sub.fail('request should not be dispatched')
      res.end()
    })
    .listen(0)

  server.on('clientError', (err) => sub.is(err.code, 'INVALID_HEADER', 'rejected by the parser'))

  await waitForServer(server)

  const raw = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\n__proto__: polluted\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.is(raw, '', 'no response')

  await closeServer(server)

  t.pass('server closed')
})

// Without backpressure a peer decides how much of a body the process holds on
// to, whether anything is reading it or not.
test('request body is not buffered past what is being read', async (t) => {
  t.plan(3)

  const total = 8 * 1024 * 1024

  let req = null

  const server = http
    .createServer((r) => {
      req = r // Deliberately never read, as a handler answering 401 would not.
    })
    .listen(0)

  await waitForServer(server)

  const socket = tcp.createConnection(server.address().port, 'localhost')

  socket.on('error', () => {})

  socket.write(
    Buffer.from(`POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${total}\r\n\r\n`)
  )

  const chunk = Buffer.alloc(64 * 1024, 0x61)

  for (let sent = 0; sent < total; sent += chunk.byteLength) {
    socket.write(chunk)

    await pause(0)
  }

  await pause(200)

  t.ok(req !== null, 'request dispatched')

  // Reaching into the stream is the only way to see what is being held, and
  // holding a bounded amount is the whole point.
  t.ok(req._readableState.buffered < total / 8, 'body is not all in memory')

  socket.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('request body still arrives in full when it is read slowly', async (t) => {
  t.plan(3)

  const total = 4 * 1024 * 1024

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      let received = 0

      req
        .on('data', (data) => {
          received += data.byteLength
        })
        .on('end', () => {
          sub.is(received, total, 'body received in full')

          res.end('ok')
        })
        .resume()
    })
    .listen(0)

  await waitForServer(server)

  const socket = tcp.createConnection(server.address().port, 'localhost')

  socket.on('error', () => {}).on('data', () => {})

  socket.write(
    Buffer.from(`POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${total}\r\n\r\n`)
  )

  const chunk = Buffer.alloc(64 * 1024, 0x61)

  for (let sent = 0; sent < total; sent += chunk.byteLength) {
    socket.write(chunk)

    await pause(0)
  }

  await sub

  t.pass('body read to the end')

  socket.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('response body is not buffered past what is being read', async (t) => {
  t.plan(3)

  const total = 8 * 1024 * 1024

  const server = tcp.createServer((socket) => {
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

  server.listen(0)

  await waitForServer(server)

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

  t.pass('server closed')
})

// A peer that answers twice is trying to have the second answer paired up with
// whatever request comes next on the connection.
test('second response on the same connection is refused', async (t) => {
  t.plan(4)

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
  const free = [...agent.freeSockets]

  t.is(free.length, 0, 'connection not pooled')
  t.is(new Set(free).size, free.length, 'no connection pooled twice')

  agent.destroy()

  await closeServer(server)

  t.pass('server closed')
})

// A peer that never finishes sending its request would otherwise hold on to the
// connection for as long as it liked.
test('request headers that never arrive time out', async (t) => {
  t.plan(3)

  const server = http
    .createServer({ headersTimeout: 200 }, (req, res) => {
      t.fail('request should not be dispatched')
      res.end()
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawBytes(server.address().port, 'GET / HTTP/1.1\r\nHost: localhost\r\n')

  t.ok(raw.startsWith('HTTP/1.1 408 Request Timeout\r\n'), 'peer told why')
  t.ok(raw.includes('Connection: close\r\n'), 'connection close announced')

  await closeServer(server)

  t.pass('server closed')
})

test('request body that never arrives times out', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer({ headersTimeout: 0, requestTimeout: 200 }, (req, res) => {
      req.on('aborted', () => sub.pass('request aborted'))
      req.resume()
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nab'
  )

  await sub

  // A handler may already be part way through answering, so the connection is
  // cut rather than answered a second time.
  t.is(raw, '', 'connection cut')

  await closeServer(server)

  t.pass('server closed')
})

// Time spent waiting on this side is not the peer's fault, so a handler that
// reads a body slowly must not have it taken away.
test('request that is read slowly does not time out', async (t) => {
  t.plan(3)

  const total = 512 * 1024

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer({ headersTimeout: 0, requestTimeout: 300 }, (req, res) => {
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
    .listen(0)

  await waitForServer(server)

  const socket = tcp.createConnection(server.address().port, 'localhost')

  socket.on('error', () => {}).on('data', () => {})

  socket.write(
    Buffer.from(`POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${total}\r\n\r\n`)
  )

  const chunk = Buffer.alloc(64 * 1024, 0x61)

  for (let sent = 0; sent < total; sent += chunk.byteLength) {
    socket.write(chunk)

    await pause(0)
  }

  await sub

  t.pass('body read to the end')

  socket.destroy()

  await closeServer(server)

  t.pass('server closed')
})

test('timeouts can be turned off', async (t) => {
  t.plan(2)

  const server = http
    .createServer({ headersTimeout: 0, requestTimeout: 0 }, (req, res) => res.end('ok'))
    .listen(0)

  await waitForServer(server)

  t.is(server.headersTimeout, 0, 'headers timeout off')

  const socket = tcp.createConnection(server.address().port, 'localhost')

  const chunks = []

  socket.on('error', () => {}).on('data', (data) => chunks.push(data))

  socket.write(Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\n'))

  await pause(500)

  // Still waiting for the rest of the headers rather than having given up.
  t.is(Buffer.concat(chunks).length, 0, 'connection left alone')

  socket.destroy()

  await closeServer(server)
})

// A body written in more than one go is only known to be too long once part of
// it is already out, so the connection goes rather than the surplus.
test('response body longer than its content length is cut off mid stream', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      res.on('error', (err) =>
        sub.is(err.code, 'CONTENT_LENGTH_MISMATCH', 'reported on the response')
      )

      res.setHeader('Content-Length', '6')
      res.write('first ')
      res.write('SURPLUS')
      res.end()
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.is(raw.includes('SURPLUS'), false, 'surplus never reaches the peer')

  await closeServer(server)

  t.pass('server closed')
})

test('a 304 content length that is not a count of bytes is refused', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      res.on('error', (err) =>
        sub.is(err.code, 'INVALID_CONTENT_LENGTH', 'reported on the response')
      )

      res.statusCode = 304
      res.setHeader('Content-Length', 'lots')
      res.end()
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawBytes(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
  )

  await sub

  t.is(raw, '', 'nothing sent')

  await closeServer(server)

  t.pass('server closed')
})

// A raw HTTP server that responds to any request and then leaves its side of
// the connection open, half-closing it first if `end` is set. Used to keep a
// connection in a state that `http.Server` would tear down on its own.
test('a request that fails to parse mid body is still answered', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => res.end('ok'))
  })

  server.listen(0)

  await waitForServer(server)

  // The headers parse, so a request exists and is mid body when the chunk size
  // turns out to be nonsense. Destroying the request must not take the socket
  // down with it, or the answer never reaches the peer.
  const response = await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\nZZZZ\r\n'
  )

  t.ok(response.includes('400 Bad Request'), 'the peer is told the request was bad')

  await closeServer(server)

  t.pass('server closed')
})

test('a clientError handler can answer a request that failed mid body', async (t) => {
  const server = http.createServer((req, res) => req.resume())

  server.on('clientError', (err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 7\r\n\r\nrefused')
  })

  server.listen(0)

  await waitForServer(server)

  const response = await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\nZZZZ\r\n'
  )

  t.ok(response.includes('refused'), "the application's own answer reaches the peer")

  await closeServer(server)

  t.pass('server closed')
})

test('an aborted request reports the reason to whoever is listening', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(2)

  const server = http.createServer((req, res) => {
    req.on('aborted', () => sub.pass('request aborted'))
    req.on('error', (err) => sub.is(err.code, 'REQUEST_TIMEOUT', 'reason reported'))
    req.resume()
  })

  server.requestTimeout = 100

  server.listen(0)

  await waitForServer(server)

  await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nab'
  )

  await sub

  t.pass('reason reported on the request')

  await closeServer(server)

  t.pass('server closed')
})

test('an aborted request with nobody listening is not an unhandled error', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http.createServer((req, res) => {
    // Deliberately no error listener, which must not take the process down.
    req.on('aborted', () => sub.pass('request aborted'))
    req.resume()
  })

  server.requestTimeout = 100

  server.listen(0)

  await waitForServer(server)

  await rawBytes(
    server.address().port,
    'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nab'
  )

  await sub

  t.pass('survived without an error listener')

  await closeServer(server)

  t.pass('server closed')
})

test('connection upgrade without an upgrade header is an ordinary request', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = http.createServer((req, res) => {
    sub.pass('handled as a request')
    res.end('ok')
  })

  // Naming no protocol, the peer has not asked for an upgrade, so it must not
  // be able to take the socket away from the request handler.
  server.on('upgrade', () => sub.fail('must not be handled as an upgrade'))

  server.listen(0)

  await waitForServer(server)

  const response = await rawRequest(
    server.address().port,
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: upgrade, close\r\n\r\n'
  )

  t.ok(response.includes('200 OK'), 'answered as a request')

  await sub

  await closeServer(server)

  t.pass('server closed')
})

test('a response that claims an upgrade without naming one is an ordinary response', async (t) => {
  t.plan(3)

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

  t.pass('response delivered')

  await closeServer(server)

  t.pass('server closed')
})

test('a connection reused from the response close handler still reads', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(1)

  const server = tcp.createServer((socket) => {
    socket.on('error', () => {})

    socket.on('data', () =>
      socket.write(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
    )
  })

  server.listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const first = http.request({ agent }, (res) => {
    // The socket goes back into the pool here, before the first request has
    // closed, so the connection must not mistake that close for the second
    // request's and forget which request it is on.
    res.on('close', () => {
      const second = http.request({ agent }, (res2) => {
        sub.is(res2.statusCode, 200, 'the reused connection still reads responses')

        res2.resume()
        res2.on('end', () => agent.destroy())
      })

      second.on('error', () => {})
      second.end()
    })

    res.resume()
  })

  first.on('error', () => {})
  first.end()

  await sub

  t.pass('connection reused')

  await closeServer(server)

  t.pass('server closed')
})

test('a 101 that names no protocol is an ordinary response', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(2)

  const server = await rawServer('HTTP/1.1 101 Switching Protocols\r\n\r\n', { end: true })

  const req = http.request({ port: server.address().port, agent: false }, (res) => {
    sub.is(res.statusCode, 101, 'delivered as a response')

    res.on('data', () => sub.fail('no body expected')).on('end', () => sub.pass('response ended'))

    res.resume()
  })

  // Having named nothing to switch to, the peer has handed the connection to
  // no one, so there is nothing to upgrade and nothing still to come.
  req.on('upgrade', () => sub.fail('must not be handled as an upgrade'))
  req.on('information', () => sub.fail('must not be handled as interim'))
  req.on('error', () => {})
  req.end()

  await sub

  t.pass('response delivered')

  await closeServer(server)

  t.pass('server closed')
})

test('a connection is not reused after a 101 that names no protocol', async (t) => {
  t.plan(3)

  const sub = t.test()
  sub.plan(2)

  // The parser stops reading for good at any 101, so the connection cannot
  // carry another exchange and must not go back into the pool offering one.
  // Counted across connections, so the second request is answered wherever it
  // turns up.
  let n = 0

  const server = tcp.createServer((socket) => {
    socket.on('error', () => {})

    socket.on('data', () => {
      if (++n === 1) socket.write(Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'))
      else socket.write(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
    })
  })

  server.listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port, keepAlive: true })

  const first = http.request({ agent }, (res) => {
    const socket = first.socket

    res.on('close', () => {
      const second = http.request({ agent }, (res2) => {
        sub.is(res2.statusCode, 200, 'the next request is answered')
        sub.not(second.socket, socket, 'on a connection of its own')

        res2.resume()
        res2.on('end', () => agent.destroy())
      })

      second.on('error', () => {})
      second.end()
    })

    res.resume()
  })

  first.on('error', () => {})
  first.end()

  await sub

  t.pass('connection not reused')

  await closeServer(server)

  t.pass('server closed')
})

test('a CONNECT request is handed over as a tunnel', async (t) => {
  t.plan(4)

  const sub = t.test()
  sub.plan(2)

  const server = http.createServer(() => sub.fail('must not be handled as a request'))

  server.on('connect', (req, socket, head) => {
    sub.is(req.url, 'localhost:443', 'authority received')
    sub.alike(head, Buffer.from('tunnel bytes'), 'head belongs to the tunnel')

    socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
  })

  server.listen(0)

  await waitForServer(server)

  const response = await rawBytes(
    server.address().port,
    'CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\ntunnel bytes'
  )

  t.ok(response.includes('200 Connection Established'), 'tunnel established')

  await sub

  t.pass('handed over rather than routed to the request handler')

  await closeServer(server)

  t.pass('server closed')
})

test('a CONNECT response is handed over as a tunnel', async (t) => {
  t.plan(3)

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

  t.pass('handed over rather than delivered as a response')

  await closeServer(server)

  t.pass('server closed')
})

test('a CONNECT request is sent without a body framing', async (t) => {
  t.plan(2)

  const sub = t.test()
  sub.plan(1)

  const server = tcp.createServer((socket) => {
    socket.on('error', () => {})

    socket.once('data', (data) => {
      // Anything after the headers would belong to the tunnel, so framing a
      // body the peer would then wait for has nothing to describe.
      sub.absent(/content-length|transfer-encoding/i.test(data.toString()), 'no framing announced')

      socket.destroy()
    })
  })

  server.listen(0)

  await waitForServer(server)

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

  t.pass('server closed')
})

test('a header value that is undefined is refused', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  // Serializing it would put the string `undefined` on the wire as though the
  // caller had meant it.
  t.exception(() => res.setHeader('x-thing', undefined), /INVALID_HEADER_VALUE/)
  t.exception(() => res.setHeader('x-thing', ['a', undefined]), /INVALID_HEADER_VALUE/)
  t.exception(() => {
    res.headers = { 'x-thing': undefined }
  }, /INVALID_HEADER_VALUE/)

  // A null value is a deliberate one and is left alone, as in Node.js.
  t.execution(() => res.setHeader('x-null', null))
})

test('control characters in a header value are refused', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  for (const c of ['\x00', '\x01', '\x0b', '\x0c', '\r', '\n', '\x7f', ' ']) {
    t.exception(
      () => res.setHeader('x-thing', 'a' + c + 'b'),
      /INVALID_HEADER_VALUE/,
      `refused ${JSON.stringify(c)}`
    )
  }

  // Latin-1 remains allowed, as it does in Node.js.
  t.execution(() => res.setHeader('x-thing', 'caf\xe9'))
})

test('control characters in a request path are refused', (t) => {
  for (const c of ['\x00', '\x01', '\r', '\n', ' ', '\t', '\x80Ā']) {
    t.exception(
      () => new http.ClientRequest({ path: '/a' + c, agent: false }),
      /INVALID_HEADER_VALUE/,
      `refused ${JSON.stringify(c)}`
    )
  }
})

test('expect 100-continue is not answered for an HTTP/1.0 client', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => res.end('ok'))
  })

  server.listen(0)

  await waitForServer(server)

  // RFC 9110 leaves an HTTP/1.0 client no way to understand a 1xx, so it would
  // read the 100 as the response to its request.
  const response = await rawBytes(
    server.address().port,
    'POST / HTTP/1.0\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\nhi'
  )

  t.absent(response.includes('100 Continue'), 'no interim response sent')
  t.ok(response.includes('200 OK'), 'request answered')

  await closeServer(server)

  t.pass('server closed')
})

test('writeHead takes the header list forms', async (t) => {
  const server = http.createServer((req, res) => {
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

  server.listen(0)

  await waitForServer(server)

  for (const path of ['/flat', '/pairs']) {
    const response = await rawRequest(
      server.address().port,
      `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`
    )

    t.ok(response.includes('X-A: 1'), `first field sent for ${path}`)
    t.ok(response.includes('X-B: 2'), `second field sent for ${path}`)
  }

  await closeServer(server)

  t.pass('server closed')
})

test('writeHead refuses a header list with a name that has no value', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  t.exception(() => res.writeHead(200, ['x-a', '1', 'x-b']), /INVALID_HEADER_VALUE/)
})

test('writeHead returns the response', (t) => {
  const res = new http.ServerResponse(null, new http.IncomingMessage())

  t.is(res.writeHead(200), res, 'chainable, as in Node.js')
})

test('an HTTP/1.0 client that asks to keep the connection is told that it is kept', async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-length', '2')
    res.end('ok')
  })

  server.listen(0)

  await waitForServer(server)

  const port = server.address().port

  // An HTTP/1.0 peer closes the connection unless it is told otherwise, so a
  // server that keeps it has to say so. The connection stays open afterwards,
  // so the reply is read up to the end of the body rather than to a close.
  const kept = await rawUntil(
    port,
    'GET / HTTP/1.0\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n',
    'ok'
  )

  t.ok(/Connection: keep-alive/i.test(kept), 'the connection is confirmed as kept')

  const closed = await rawBytes(port, 'GET / HTTP/1.0\r\nHost: localhost\r\n\r\n')

  t.ok(/Connection: close/i.test(closed), 'and closed when it was not asked for')

  await closeServer(server)

  t.pass('server closed')
})

test('a HEAD response of unknown length announces no framing', async (t) => {
  const server = http.createServer((req, res) => {
    // Written in pieces, so the length is not known when the headers go out.
    res.write('hello')
    res.end(' there')
  })

  server.listen(0)

  await waitForServer(server)

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

  t.pass('server closed')
})

// Time spent answering a request is not the peer's fault either. The headers
// deadline is there to bound the wait for the next request, which only starts
// once the current one has been answered.
test('a slow handler does not lose its response to the headers timeout', async (t) => {
  t.plan(3)

  const server = http
    .createServer({ headersTimeout: 200, requestTimeout: 0 }, (req, res) => {
      req.resume()

      setTimeout(() => res.end('the-response-body'), 600)
    })
    .listen(0)

  await waitForServer(server)

  const raw = await rawBytes(server.address().port, 'GET /slow HTTP/1.1\r\nHost: localhost\r\n\r\n')

  t.ok(raw.includes('200 OK'), 'response sent')
  t.ok(raw.endsWith('the-response-body'), 'response body sent in full')

  await closeServer(server)

  t.pass('server closed')
})

// A request that is closed after the next one has already been handed the
// connection must not take it away from it, or the request in flight is left
// waiting for a body that is being thrown away.
test('a request that closes late does not detach the next one', async (t) => {
  t.plan(4)

  const sub = t.test()
  sub.plan(1)

  let first = null

  const server = http
    .createServer((req, res) => {
      if (first === null) {
        // Body deliberately left unread, so that the request stays open past
        // its response and into the next request.
        first = req
      } else {
        const chunks = []

        req.on('data', (data) => chunks.push(data))
        req.on('end', () =>
          sub.alike(Buffer.concat(chunks), Buffer.from('bb'), 'second body received')
        )
      }

      res.end('ok')
    })
    .listen(0)

  await waitForServer(server)

  const port = server.address().port

  const raw = new Promise((resolve, reject) => {
    const socket = tcp.createConnection(port, 'localhost')

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

  t.pass('server closed')
})

// Whether a handler got around to reading a request it was given says nothing
// about whether the peer is still being waited on.
test('a connection whose request body went unread still counts as idle', async (t) => {
  t.plan(3)

  const server = http
    .createServer((req, res) => res.end('ok')) // Body deliberately left unread
    .listen(0)

  await waitForServer(server)

  const port = server.address().port

  const socket = tcp.createConnection(port, 'localhost')

  socket.on('error', () => {})

  socket.write(Buffer.from('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\naa'))

  await waitFor(socket, 'data')
  await pause(100)

  const connection = http.ServerConnection.for([...server.connections][0])

  t.ok(connection.idle, 'connection idle once the request has arrived in full')

  // Would otherwise wait for the headers deadline to reclaim the connection.
  await new Promise((resolve) => {
    server.close(resolve)

    setTimeout(() => t.fail('server did not close'), 2000).unref()
  })

  t.pass('server closed')

  socket.destroy()

  await waitFor(socket, 'close')

  t.pass('client socket closed')
})

// Splicing a canned response into one that has already begun would have the
// peer count the status line towards the body it was promised, and read what
// is left over as the start of the next response.
test('a request that fails mid response is not answered over the response', async (t) => {
  t.plan(4)

  const server = http
    .createServer((req, res) => {
      res.setHeader('content-length', '10')
      res.write(Buffer.from('01234'))
      // Response deliberately left half written.
    })
    .listen(0)

  await waitForServer(server)

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

  t.pass('server closed')
})

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
