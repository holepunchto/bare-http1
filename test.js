const test = require('brittle')
const tcp = require('bare-tcp')
const http = require('.')

test('basic', async function (t) {
  t.plan(26)

  const server = http.createServer()

  server.on('listening', function () {
    t.pass('server listening')
  })

  server.on('connection', function (socket) {
    t.ok(socket)

    socket.on('close', () => {
      t.pass('server socket closed')
    })

    socket.on('error', (err) =>
      t.fail('server socket error: ' + err.message + ' (' + err.code + ')')
    )
  })

  server.on('request', function (req, res) {
    t.ok(req)
    t.is(req.method, 'POST')
    t.is(req.url, '/something/?key1=value1&key2=value2&enabled')
    t.is(
      req.headers.host,
      server.address().address + ':' + server.address().port
    )
    t.ok(req.socket)

    t.ok(res)
    t.is(res.statusCode, 200, 'default status code')
    t.alike(res.headers, {})
    t.ok(res.socket)
    t.is(res.req, req)
    t.is(res.headersSent, false, 'headers not flushed')

    t.is(req.socket, res.socket)

    res.setHeader('Content-Length', 12)
    t.alike(res.headers, { 'content-length': 12 })
    t.is(res.getHeader('content-length'), 12)
    t.is(res.getHeader('Content-Length'), 12)

    res.end('Hello world!')

    req.on('close', function () {
      t.pass('server request closed')
    })

    req.on('data', function (data) {
      t.alike(data, Buffer.from('body message'), 'request body')
    })

    res.on('close', function () {
      t.is(res.headersSent, true, 'headers flushed')
      t.pass('server response closed')
    })
  })

  server.listen(0)
  await waitForServer(server)

  const reply = await request(
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

  t.absent(reply.error)
  t.is(reply.response.statusCode, 200)

  const body = Buffer.concat(reply.response.chunks)
  t.alike(body, Buffer.from('Hello world!'), 'client response ended')

  server.close(() => t.pass('server closed'))
})

test('port already in use', async function (t) {
  t.plan(2)

  const server = http.createServer()
  server.listen(0)
  await waitForServer(server)

  const server2 = http.createServer()
  server2.listen(server.address().port)
  server2.on('error', (err) => {
    t.is(err.code, 'EADDRINUSE')

    server.close()
    server.on('close', () => t.pass('original server closed'))
  })
})

test('destroy request', async function (t) {
  t.plan(5)

  const server = http.createServer()
  server.on('close', () => t.pass('server closed'))

  server.on('connection', function (socket) {
    socket.on('close', () => t.pass('server socket closed'))
    socket.on('error', (err) =>
      t.fail('server socket error: ' + err.message + ' (' + err.code + ')')
    )
  })

  server.on('request', function (req, res) {
    req.destroy()

    req.on('close', () => t.pass('server request closed'))
  })

  server.listen(0)
  await waitForServer(server)

  const reply = await request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(reply.response, 'client should not receive a response')

  t.ok(reply.error, 'client errored')

  server.close()
})

test('destroy response', async function (t) {
  t.plan(6)

  const server = http.createServer()
  server.on('close', () => t.pass('server closed'))

  server.on('connection', function (socket) {
    socket.on('close', () => t.pass('server socket closed'))
    socket.on('error', (err) =>
      t.fail('server socket error: ' + err.message + ' (' + err.code + ')')
    )
  })

  server.on('request', function (req, res) {
    res.destroy()

    req.on('close', () => t.pass('server request closed'))
    res.on('close', () => t.pass('server response closed'))
  })

  server.listen(0)
  await waitForServer(server)

  const reply = await request({
    method: 'POST',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(reply.response, 'client should not receive a response')
  t.ok(reply.error, 'client errored')

  server.close()
})

test('write head', async function (t) {
  t.plan(8)

  const server = http.createServer()
  server.on('close', () => t.pass('server closed'))

  server.on('connection', function (socket) {
    socket.on('close', () => t.pass('server socket closed'))
    socket.on('error', (err) =>
      t.fail('server socket error: ' + err.message + ' (' + err.code + ')')
    )
  })

  server.on('request', function (req, res) {
    req.resume()
    res.writeHead(404) // TODO: should set content-length to zero?
    res.end()

    req.on('close', () => t.pass('server request closed'))
    res.on('close', () => t.pass('server response closed'))
  })

  server.listen(0)
  await waitForServer(server)

  const reply = await request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(reply.error)
  t.is(reply.response.statusCode, 404)

  t.alike(reply.response.chunks, [])
  t.ok(reply.response.ended)

  server.close()
})

test('write head with headers', async function (t) {
  t.plan(9)

  const server = http.createServer()
  server.on('close', () => t.pass('server closed'))

  server.on('connection', function (socket) {
    socket.on('close', () => t.pass('server socket closed'))
    socket.on('error', (err) =>
      t.fail('server socket error: ' + err.message + ' (' + err.code + ')')
    )
  })

  server.on('request', function (req, res) {
    req.resume()
    res.writeHead(404, { 'x-custom': 1234 })
    res.end()

    req.on('close', () => t.pass('server request closed'))
    res.on('close', () => t.pass('server response closed'))
  })

  server.listen(0)
  await waitForServer(server)

  const reply = await request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(reply.error)
  t.is(reply.response.statusCode, 404)
  t.alike(reply.response.chunks, [], 'client should not receive data')
  t.ok(reply.response.ended, 'client response ended')
  t.is(reply.response.headers['x-custom'], '1234')

  server.close()
})

test('chunked', async function (t) {
  t.plan(8)

  const server = http.createServer()
  server.on('close', () => t.pass('server closed'))

  server.on('connection', function (socket) {
    socket.on('close', () => t.pass('server socket closed'))
    socket.on('error', (err) =>
      t.fail('server socket error: ' + err.message + ' (' + err.code + ')')
    )
  })

  server.on('request', function (req, res) {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks.map((c) => Buffer.from(c, 'hex')))
      t.alike(
        body,
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

  server.listen(0)
  await waitForServer(server)

  const reply = await request(
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

  t.absent(reply.error)
  t.is(reply.response.statusCode, 200)

  const body = Buffer.concat(reply.response.chunks)

  t.alike(
    body,
    Buffer.from('response part 1 + response part 2'),
    'client response ended'
  )

  server.close()
})

test('destroy socket', async function (t) {
  t.plan(4)

  const server = http.createServer()
  server.on('close', () => t.pass('server closed'))

  server.on('connection', function (socket) {
    socket.destroy()

    socket.on('close', () => t.pass('server socket closed'))
    socket.on('error', (err) => {
      t.fail('server socket error: ' + err.message + ' (' + err.code + ')')
    })
  })

  server.on('request', function (req, res) {
    t.fail('server should not receive request')
  })

  server.listen(0)
  await waitForServer(server)

  const reply = await request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(reply.response)
  t.ok(reply.error, 'had error')

  server.close()
})

test('close server request/response at premature GET request closure', async function (t) {
  const sub = t.test('')
  sub.plan(2)

  const server = http
    .createServer((req, res) => {
      req.resume()
      req.on('close', () => sub.pass('request closed'))
      res.on('close', () => sub.pass('response closed'))
    })
    .listen(0)

  await waitForServer(server)

  const client = tcp.createConnection(server.address().port)
  client.write('GET / HTTP/1.1\r\n\r\n')

  setTimeout(() => client.destroy(), 300)

  await sub

  server.close()
})

test('close server request/response at premature POST request closure', async function (t) {
  const sub = t.test('')
  sub.plan(2)

  const server = http
    .createServer((req, res) => {
      req.resume()
      req.on('close', () => sub.pass('request closed'))
      res.on('close', () => sub.pass('response closed'))
    })
    .listen(0)

  await waitForServer(server)

  const client = tcp.createConnection(server.address().port)
  client.write('POST / HTTP/1.1\r\nContent-Length: 10000000\r\n\r\n')

  setTimeout(() => client.destroy(), 300)

  await sub

  server.close()
})

test('server and client do big writes', async function (t) {
  t.plan(8)

  const server = http.createServer()
  server.on('close', () => t.pass('server closed'))

  server.on('connection', function (socket) {
    socket.on('close', () => t.pass('server socket closed'))
    socket.on('error', (err) => {
      t.fail('server socket error: ' + err.message + ' (' + err.code + ')')
    })
  })

  server.on('request', function (req, res) {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks.map((c) => Buffer.from(c, 'hex')))
      const expected = Buffer.concat([
        Buffer.alloc(2 * 1024 * 1024, 'qwer'),
        Buffer.alloc(2 * 1024 * 1024, 'asdf')
      ])
      t.alike(body, expected, 'request body ended')

      res.write(Buffer.alloc(2 * 1024 * 1024, 'abcd'))
      setImmediate(() => {
        res.end(Buffer.alloc(2 * 1024 * 1024, 'efgh'))
      })
    })

    req.on('close', () => t.pass('server request closed'))
    res.on('close', () => t.pass('server response closed'))
  })

  server.listen(0)
  await waitForServer(server)

  const reply = await request(
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

  t.is(reply.response.statusCode, 200)
  t.ok(reply.response.ended)

  const body = Buffer.concat(reply.response.chunks)
  const expected = Buffer.concat([
    Buffer.alloc(2 * 1024 * 1024, 'abcd'),
    Buffer.alloc(2 * 1024 * 1024, 'efgh')
  ])
  t.alike(body, expected, 'client response ended')

  server.close()
})

test('basic protocol negotiation', async function (t) {
  const up = t.test('upgrade event')
  up.plan(4)

  const server = http.createServer().listen(0)
  await waitForServer(server)

  server.on('upgrade', (req, socket, head) => {
    up.alike(head, Buffer.from('request head'), 'server upgrade event')

    req.on('close', () => up.pass('request closed after server upgrade event'))

    req.on('data', () =>
      t.fail('request data event listener should be detached')
    )
    req.on('drain', () =>
      t.fail('request drain event listener should be detached')
    )
    req.on('end', () => t.fail('request end event listener should be detached'))
    req.on('error', () =>
      t.fail('request error event listener should be detached')
    )

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
    up.alike(head, Buffer.from('server head'), 'request upgrade event')

    req.on('close', () => up.pass('request closed after request upgrade event'))

    res.on('close', () =>
      t.fail('response close event listener should be detached')
    )
    res.on('data', () =>
      t.fail('response data event listener should be detached')
    )
    res.on('drain', () =>
      t.fail('response drain event listener should be detached')
    )
    res.on('end', () =>
      t.fail('response end event listener should be detached')
    )
    res.on('error', () =>
      t.fail('response error event listener should be detached')
    )

    socket.end()
  })

  await up

  server.close()
})

test('close connection if missing upgrade handler', async function (t) {
  const ce = t.test('close event')
  ce.plan(1)

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

  req.on('close', () => ce.pass('connection closed'))

  await ce

  server.close()
})

test('make requests using url', async function (t) {
  const rqts = t.test('requests')
  t.plan(2)
  rqts.plan(2)

  const server = http.createServer().listen(0)
  await waitForServer(server)
  server.on('request', (req, res) => {
    t.is(req.url, '/path')
    res.end('response')
  })

  const url = `http://localhost:${server.address().port}/path`
  const expectedBuf = Buffer.from('response')

  http
    .request(url, (res) => {
      res.on('data', (data) => rqts.alike(data, expectedBuf, 'url as string'))
    })
    .end()

  http
    .request(new URL(url), (res) => {
      res.on('data', (data) => rqts.alike(data, expectedBuf, 'url instance'))
    })
    .end()

  await rqts

  server.close()
})

test('custom request headers', async function (t) {
  const ht = t.test('headers')
  ht.plan(1)

  const server = http.createServer().listen(0)
  await waitForServer(server)

  server.on('request', (req, res) => {
    res.end()
    ht.is(req.headers['custom-header'], 'value')
  })

  const { port } = server.address()
  http.request({ port, headers: { 'custom-header': 'value' } }).end()

  await ht

  server.close()
})

test('request timeout', async function (t) {
  t.plan(3)

  const sub = t.test()
  sub.plan(2)

  const server = http
    .createServer((req, res) => {
      sub.then(() => res.end())
    })
    .listen(0)

  await waitForServer(server)

  const req = http.request({ port: server.address().port }).end()

  req
    .on('error', () => t.pass('socket closed'))
    .on('timeout', () => sub.pass('event'))
    .setTimeout(100, () => sub.pass('callback'))

  await sub

  server.close(() => t.pass('server closed'))
})

test('server timeout', async function (t) {
  t.plan(3)

  const sub = t.test()
  sub.plan(3)

  const server = http
    .createServer((req, res) => {
      res.end()
    })
    .listen(0)

  server.setTimeout(100, (socket) => {
    sub.is(typeof socket, 'object', 'callback receive socket as argument')
  })

  server.on('timeout', (socket) => {
    sub.is(typeof socket, 'object', 'event receive socket as argument')
  })

  sub.is(server.timeout, 100, 'timeout getter')

  await waitForServer(server)

  const { port } = server.address()
  const req = http.request({ port })

  req.on('error', () => t.pass('request timeout'))

  await sub

  req.end()
  server.close(() => t.pass('server closed'))
})

test('close the server at timeout if do not have any handler', async function (t) {
  t.plan(1)
  const server = http.createServer().listen(0).setTimeout(100)

  await waitForServer(server)

  const client = http.request({ port: server.address().port })

  client.on('error', () => {
    t.pass()

    server.close()
  })
})

test('do not close the server at timeout if a handler is found', async function (t) {
  t.plan(2)

  const server = http.createServer((req, res) => {
    res.on('timeout', () => {
      t.pass('response timeout')

      res.end()
      server.close()
    })
  })

  server.listen(0).setTimeout(100)

  await waitForServer(server)

  const req = http.request({ port: server.address().port }).end()

  req.on('error', () => t.pass('socket closed'))
})

test('server response timeout', async function (t) {
  t.plan(3)

  const sub = t.test()
  sub.plan(2)

  const server = http
    .createServer((req, res) => {
      res.setTimeout(100, () => sub.pass('timeout callback'))
      res.on('timeout', () => sub.pass('timeout event'))

      sub.then(() => res.end())
    })
    .listen(0)

  await waitForServer(server)

  const req = http.request({ port: server.address().port }).end()

  req.on('error', () => t.pass('socket closed'))

  await sub

  server.close(() => t.pass('server closed'))
})

test('cancel timeouts when has upgrade event handled', async function (t) {
  const server = http.createServer().listen(0)

  server.setTimeout(100, () => t.fail('timeout callback'))
  server.on('timeout', () => t.fail('timeout event'))

  server.on('upgrade', (req, socket, head) => {
    const handshake =
      'HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade\r\n' +
      '\r\n'

    socket.end(handshake)
  })

  await waitForServer(server)

  const client = http
    .request({
      port: server.address().port,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'weird-protocol'
      }
    })
    .end()

  client.setTimeout(100, () => t.fail('client callback'))
  client.on('timeout', () => t.fail('client event'))

  let upgradedSocket
  client.on('upgrade', (res, socket) => {
    upgradedSocket = socket
  })

  setTimeout(() => {
    t.end()

    upgradedSocket.end()
    server.close()
  }, 400)
})

test('socket reuse', async function (t) {
  t.plan(2)

  const sub = t.test()
  sub.plan(3)

  const server = http
    .createServer((req, res) => {
      res.end('response')
    })
    .listen(0)

  await waitForServer(server)

  const { port } = server.address()
  const agent = new http.Agent({ port, keepAlive: true })

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
            sub.is(req.socket, socket, 'socket was reused')

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

test('destroy timeouted free socket', async function (t) {
  const sub = t.test()
  sub.plan(1)

  const server = http
    .createServer((req, res) => {
      res.end()
    })
    .listen(0)

  await waitForServer(server)

  const agent = new http.Agent({
    port: server.address().port,
    keepAlive: true,
    timeout: 500
  })

  let socket

  let req = http
    .request({ agent }, (res) => {
      socket = req.socket
    })
    .on('close', () => {
      setTimeout(() => {
        req = http
          .request({ agent }, (res) => {
            sub.not(req.socket, socket, 'socket was not reused')
          })
          .end()
      }, 1000)
    })
    .end()

  await sub

  server.close()
})

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

    client.on('error', function (err) {
      result.error = err.message
    })

    client.on('response', function (res) {
      const r = (result.response = {
        statusCode: res.statusCode,
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
      if (result.response)
        result.response.chunks = result.response.chunks.map((c) =>
          Buffer.from(c, 'hex')
        )
      resolve(result)
    })

    if (cb) {
      cb(client)
    } else {
      client.end()
    }
  })
}
