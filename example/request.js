const http = require('..')

const req = http.request({ port: 8080 }, res => {
  console.log('status:', res.statusCode)

  let rawData = ''

  res
    .on('end', () => console.log(rawData))
    .on('data', (chunk) => {
      rawData += chunk
    })
})

req.end()
