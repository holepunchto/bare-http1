const test = require('brittle')
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

    socket.on('error', (err) => t.fail('server socket error: ' + err.message + ' (' + err.code + ')'))
  })

  server.on('request', function (req, res) {
    t.ok(req)
    t.is(req.method, 'GET')
    t.is(req.url, '/something/?key1=value1&key2=value2&enabled')
    t.is(req.headers.host, server.address().address + ':' + server.address().port)
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

  const reply = await request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/something/?key1=value1&key2=value2&enabled',
    headers: { 'Content-Length': 12 }
  }, (req) => {
    req.write('body message')
    req.end()
  })

  t.absent(reply.error)
  t.is(reply.response.statusCode, 200)

  const body = Buffer.concat(reply.response.chunks)
  t.alike(body, Buffer.from('Hello world!'), 'client response ended')

  server.close()
  server.on('close', () => t.pass('server closed'))
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
    socket.on('error', (err) => t.fail('server socket error: ' + err.message + ' (' + err.code + ')'))
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
    socket.on('error', (err) => t.fail('server socket error: ' + err.message + ' (' + err.code + ')'))
  })

  server.on('request', function (req, res) {
    res.destroy()

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
    socket.on('error', (err) => t.fail('server socket error: ' + err.message + ' (' + err.code + ')'))
  })

  server.on('request', function (req, res) {
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
    socket.on('error', (err) => t.fail('server socket error: ' + err.message + ' (' + err.code + ')'))
  })

  server.on('request', function (req, res) {
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
    socket.on('error', (err) => t.fail('server socket error: ' + err.message + ' (' + err.code + ')'))
  })

  server.on('request', function (req, res) {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks.map(c => Buffer.from(c, 'hex')))
      t.alike(body, Buffer.from('request body part 1 + request body part 2'), 'request body ended')
    })

    res.write('response part 1 + ')
    setImmediate(() => { res.end('response part 2') })

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
  }, (req) => {
    req.write('request body part 1 + ')
    setImmediate(() => { req.end('request body part 2') })
  })

  t.absent(reply.error)
  t.is(reply.response.statusCode, 200)

  const body = Buffer.concat(reply.response.chunks)

  t.alike(body, Buffer.from('response part 1 + response part 2'), 'client response ended')

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
      const body = Buffer.concat(chunks.map(c => Buffer.from(c, 'hex')))
      const expected = Buffer.concat([
        Buffer.alloc(2 * 1024 * 1024, 'qwer'),
        Buffer.alloc(2 * 1024 * 1024, 'asdf')
      ])
      t.alike(body, expected, 'request body ended')
    })

    res.write(Buffer.alloc(2 * 1024 * 1024, 'abcd'))
    setImmediate(() => { res.end(Buffer.alloc(2 * 1024 * 1024, 'efgh')) })

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
  }, (req) => {
    req.write(Buffer.alloc(2 * 1024 * 1024, 'qwer'))
    setImmediate(() => { req.end(Buffer.alloc(2 * 1024 * 1024, 'asdf')) })
  })

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
  up.plan(2)

  const server = http.createServer().listen(0)
  await waitForServer(server)

  server.on('upgrade', (req, socket, head) => {
    up.alike(head, Buffer.from('request head'), 'server upgrade event')

    const handshake = 'HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade\r\n' +
      '\r\n' +
      'server head'

    socket.end(handshake)
  })

  const req = http.request({
    port: server.address().port,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'weird-protocol'
    }
  }).end('request head')

  req.on('upgrade', (res, socket, head) => {
    up.alike(head, Buffer.from('server head'), 'request upgrade event')

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
    const handshake = 'HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
      'Upgrade: weird-protocol\r\n' +
      'Connection: Upgrade\r\n' +
      '\r\n'

    socket.end(handshake)
  })

  const req = http.request({
    port: server.address().port,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'weird-protocol'
    }
  }).end()

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

  const _url = `http://0.0.0.0:${server.address().port}/path`
  const expectedBuf = Buffer.from('response')

  http.request(_url, res => {
    res.on('data', (data) => rqts.alike(data, expectedBuf, 'url as string'))
  }).end()

  http.request(new URL(_url), res => {
    res.on('data', (data) => rqts.alike(data, expectedBuf, 'url instance'))
  }).end()

  await rqts

  server.close()
})

test('custom request headers', async function (t) {
  const ht = t.test('headers')
  ht.plan(1)

  const server = http.createServer().listen(0)
  await waitForServer(server)

  server.on('request', (req, res) => {
    ht.is(req.headers['custom-header'], 'value')
    res.end()
  })

  const { port } = server.address()
  http.request({ port, headers: { 'custom-header': 'value' } }).end()

  await ht

  server.close()
})

function waitForServer (server) {
  return new Promise((resolve, reject) => {
    server.on('listening', done)
    server.on('error', done)

    function done (error) {
      server.removeListener('listening', done)
      server.removeListener('error', done)
      error ? reject(error) : resolve()
    }
  })
}

function request (opts, cb) {
  return new Promise((resolve) => {
    const client = http.request(opts)

    const result = { statusCode: 0, error: null, response: null }

    client.on('error', function (err) {
      result.error = err.message
    })

    client.on('response', function (res) {
      const r = result.response = { statusCode: res.statusCode, headers: res.headers, ended: false, chunks: [] }
      r.statusCode = res.statusCode
      res.on('data', (chunk) => r.chunks.push(chunk))
      res.on('end', () => {
        r.ended = true
      })
    })

    client.on('close', () => {
      if (result.response) result.response.chunks = result.response.chunks.map(c => Buffer.from(c, 'hex'))
      resolve(result)
    })

    if (cb) {
      cb(client)
    } else {
      client.end()
    }
  })
}
