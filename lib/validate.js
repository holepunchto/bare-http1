const errors = require('./errors')

// RFC 7230 token = 1*tchar
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// Reject characters that would terminate or split the current line
const VALUE_INVALID_RE = /[\r\n\0]/

// Reject control chars and whitespace in the request-target
const PATH_INVALID_RE = /[\r\n\0\s]/

exports.validateHeaderName = function (name) {
  if (typeof name !== 'string' || !TOKEN_RE.test(name)) {
    throw errors.INVALID_HEADER_NAME(`Invalid header name: ${JSON.stringify(name)}`)
  }
}

exports.validateHeaderValue = function (name, value) {
  if (value === undefined || value === null) return
  if (VALUE_INVALID_RE.test(String(value))) {
    throw errors.INVALID_HEADER_VALUE(
      `Invalid character in header value for ${JSON.stringify(name)}`
    )
  }
}

exports.validateStatusMessage = function (value) {
  if (value === undefined || value === null) return
  if (VALUE_INVALID_RE.test(String(value))) {
    throw errors.INVALID_HEADER_VALUE('Invalid character in status message')
  }
}

exports.validatePath = function (value) {
  if (typeof value !== 'string' || value.length === 0 || PATH_INVALID_RE.test(value)) {
    throw errors.INVALID_HEADER_VALUE(`Invalid character in request path: ${JSON.stringify(value)}`)
  }
}

exports.validateMethod = function (value) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
    throw errors.INVALID_HEADER_NAME(`Invalid HTTP method: ${JSON.stringify(value)}`)
  }
}
