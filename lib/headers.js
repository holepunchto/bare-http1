const validate = require('./validate')

// Returns a copy of the headers with every name lowercased, so that a header
// can only ever be set once no matter which casing the caller used. Sending a
// header twice is a framing hazard for anything that reads Content-Length.
exports.normalize = function (headers) {
  const normalized = {}

  if (headers) {
    for (const name of Object.keys(headers)) {
      const n = name.toLowerCase()

      validate.validateHeaderName(n)
      validate.validateHeaderValue(n, headers[name])

      normalized[n] = headers[name]
    }
  }

  return normalized
}

// Headers such as `Connection` carry a comma separated list of tokens, which
// are case insensitive.
exports.hasToken = function (value, token) {
  if (value === undefined || value === null) return false

  for (const t of String(value).split(',')) {
    if (t.trim().toLowerCase() === token) return true
  }

  return false
}
