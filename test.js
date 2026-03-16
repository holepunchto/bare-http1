const test = require('brittle')
// const tcp = require('bare-tcp')
// const http = require('.')

const tcp = require(global.Bare ? 'bare-tcp' : 'net')
const http = require(global.Bare ? '.' : 'http')

test('basic', async (t) => {
  t.plan(23)

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

      t.is(req.socket, res.socket)

      res.setHeader('Content-Length', 12)
      t.is(res.getHeader('content-length'), 12)
      t.is(res.getHeader('Content-Length'), 12)

      req
        .on('close', () => t.pass('server request closed'))
        .on('data', (data) => {
          t.alike(data, Buffer.from('body message'), 'request body')
        })

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
  t.is(req.response.statusCode, 200)
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

test('destroy partial GET request', async (t) => {
  const sub = t.test('')
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
  const sub = t.test('')
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

test('protocol negotiation', async (t) => {
  const up = t.test('upgrade')
  up.plan(7)

  const server = http.createServer().listen(0)
  await waitForServer(server)

  server.on('upgrade', (req, socket, head) => {
    up.alike(head, Buffer.from('request head'), 'server upgrade')

    req
      .on('end', () => up.pass('server request ended'))
      .on('close', () => up.pass('server request closed'))

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
    up.alike(head, Buffer.from('server head'), 'client upgrade')

    req.on('close', () => up.pass('client request closed'))

    res
      .on('close', () => up.pass('client response closed'))
      .on('end', () => up.pass('client response ended'))

    res
      .on('data', () => t.fail())
      .on('drain', () => t.fail())
      .on('error', () => t.fail())

    socket.end()
  })

  await up

  server.close()
})

test('close connection if missing upgrade handler', async (t) => {
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

test('GET request', async (t) => {
  t.plan(6)

  const sub = t.test('requests')
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

  const sub = t.test('headers')
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
            sub.is(req.socket, socket, 'socket reused')

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

test('socket reuse, socket closes after timeout', async (t) => {
  t.plan(2)

  const sub = t.test()
  sub.plan(2)

  const server = http.createServer((req, res) => res.end('response')).listen(0)

  await waitForServer(server)

  const agent = new http.Agent({ port: server.address().port, keepAlive: true, timeout: 500 })

  let req = http
    .request({ agent }, (res) => {
      res.on('close', () => sub.pass('response closed')).resume()

      req.socket.on('close', () => sub.pass('socket closed'))
    })
    .end()

  await sub

  server.close(() => t.pass('server closed'))
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
        result.response.chunks = result.response.chunks.map((c) => Buffer.from(c, 'hex'))
      resolve(result)
    })

    if (cb) {
      cb(client)
    } else {
      client.end()
    }
  })
}
