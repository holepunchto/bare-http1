const { test, skip } = require('brittle')
// const { spawn } = require('bare-subprocess')
const { createServer, request } = require('.')

test('basic', async function (t) {
  t.plan(25)

  const server = createServer()

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
    t.alike(req.headers, { host: server.address().address + ':' + server.address().port })
    // t.alike(req.headers, { host: server.address().address + ':' + server.address().port, connection: 'keep-alive' })
    // t.alike(req.getHeader('connection'), 'keep-alive')
    // t.alike(req.getHeader('Connection'), 'keep-alive')
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

    res.on('close', function () {
      t.is(res.headersSent, true, 'headers flushed')
      t.pass('server response closed')
    })
  })

  server.listen(0)
  await waitForServer(server)

  const reply = await _request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/something/?key1=value1&key2=value2&enabled'
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

  const server = createServer()
  server.listen(0)
  await waitForServer(server)

  const server2 = createServer()
  server2.listen(server.address().port)
  server2.on('error', (err) => {
    t.is(err.code, 'EADDRINUSE')

    server.close()
    server.on('close', () => t.pass('original server closed'))
  })
})

test('destroy request', async function (t) {
  t.plan(5)

  const server = createServer()
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

  const reply = await _request({
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

  const server = createServer()
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

  const reply = await _request({
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

  const server = createServer()
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

  const reply = await _request({
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

  const server = createServer()
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

  const reply = await _request({
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
  t.plan(7)

  const server = createServer()
  server.on('close', () => t.pass('server closed'))

  server.on('connection', function (socket) {
    socket.on('close', () => t.pass('server socket closed'))
    socket.on('error', (err) => t.fail('server socket error: ' + err.message + ' (' + err.code + ')'))
  })

  server.on('request', function (req, res) {
    res.write('part 1 + ')
    setImmediate(() => res.end('part 2'))

    req.on('close', () => t.pass('server request closed'))
    res.on('close', () => t.pass('server response closed'))
  })

  server.listen(0)
  await waitForServer(server)

  const reply = await _request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(reply.error)
  t.is(reply.response.statusCode, 200)

  const body = Buffer.concat(reply.response.chunks)

  console.log('body:', body.toString())

  t.alike(body, Buffer.from('part 1 + part 2'), 'client response ended')

  server.close()
})

test('destroy socket', async function (t) {
  t.plan(4)

  const server = createServer()
  server.on('close', () => t.pass('server closed')) // check 4

  server.on('connection', function (socket) {
    socket.destroy()

    socket.on('close', () => t.pass('server socket closed')) // check 1
    socket.on('error', (err) => {
      t.fail('server socket error: ' + err.message + ' (' + err.code + ')')
    })
  })

  server.on('request', function (req, res) {
    t.fail('server should not receive request')
  })

  server.listen(0)
  await waitForServer(server)

  const reply = await _request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.absent(reply.response) // check 2
  t.ok(reply.error, 'had error')

  server.close()
})

skip('server does a big write', async function (t) {
  t.plan(7)

  const server = createServer()
  server.on('close', () => t.pass('server closed'))

  server.on('connection', function (socket) {
    socket.on('close', () => t.pass('server socket closed'))
    socket.on('error', (err) => {
      t.fail('server socket error: ' + err.message + ' (' + err.code + ')')
    })
  })

  server.on('request', function (req, res) {
    res.write(Buffer.alloc(2 * 1024 * 1024, 'abcd'))
    setImmediate(() => {
      res.end(Buffer.alloc(2 * 1024 * 1024, 'efgh'))
    })

    req.on('close', () => t.pass('server request closed'))
    res.on('close', () => t.pass('server response closed'))
  })

  server.listen(0)
  await waitForServer(server)

  const reply = await _request({
    method: 'GET',
    host: server.address().address,
    port: server.address().port,
    path: '/'
  })

  t.is(reply.response.statusCode, 200)
  t.ok(reply.response.ended)

  const body = Buffer.concat(reply.response.chunks)
  const expected = Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 'abcd'), Buffer.alloc(2 * 1024 * 1024, 'efgh')])
  t.alike(body, expected, 'client response ended')

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

function _request (opts) {
  return new Promise((resolve) => {
    const client = request(opts)

    const result = { statusCode: 0, error: null, response: null }

    client.on('error', function (err) {
      result.error = err.message
    })

    client.on('response', function (res) {
      const r = result.response = { statusCode: res.statusCode, headers: res.headers, ended: false, chunks: [] }
      r.statusCode = res.statusCode
      res.on('data', (chunk) => {
        r.chunks.push(chunk.toString('hex'))
      })
      res.on('end', () => {
        r.ended = true
      })
    })

    client.on('close', () => {
      if (result.response) result.response.chunks = result.response.chunks.map(c => Buffer.from(c, 'hex'))
      resolve(result)
    })

    client.end()
  })
}

/*
function __request (opts) {
  const src = `
    const http = require('http')
    const client = http.request(${JSON.stringify(opts)})

    const result = {
      statusCode: 0,
      error: null,
      response: null
    }

    client.on('error', function (err) {
      result.error = err.message
    })

    client.on('response', function (res) {
      const r = result.response = { statusCode: res.statusCode, headers: res.headers, ended: false, chunks: [] }
      r.statusCode = res.statusCode
      res.on('data', (chunk) => r.chunks.push(chunk.toString('hex')))
      res.on('end', () => {
        r.ended = true
      })
    })

    client.on('close', () => {
      process.stdout.write(JSON.stringify(result))
    })

    client.end()
  `

  const proc = spawn('node', ['-e', src])
  const all = []

  proc.stdout.on('data', function (data) {
    all.push(data)
  })

  return new Promise((resolve, reject) => {
    proc.on('exit', function (code) {
      if (code) return reject(new Error('Bad exit: ' + code))
      const result = JSON.parse(Buffer.concat(all).toString())
      if (result.response) result.response.chunks = result.response.chunks.map(c => Buffer.from(c, 'hex'))
      resolve(result)
    })
  })
}
*/
