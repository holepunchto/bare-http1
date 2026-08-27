const errors = require('./errors')

// RFC 9110 token = 1*tchar
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

// A bare CR or LF would terminate or split the current line outright, and the
// remaining control characters are the ones intermediaries disagree about, so
// they are refused for the same reason Node.js refuses them: whatever this side
// meant by them, the next hop may read the message differently.
const VALUE_INVALID_RE = /[^\t\x20-\x7e\x80-\xff]/

// The request-target sits on the request line, so any whitespace would split
// it, and anything outside Latin-1 has to be percent encoded before it can be
// sent. Matches what Node.js accepts, less the one whitespace character that
// falls inside the range.
const PATH_INVALID_RE = /[^\u0021-\u00ff]|\s/

// A valid token that would reach the `Object.prototype` setter of the same name
// if it were ever used as a property. The header bags are created without a
// prototype, but the name is refused outright so that it cannot be reintroduced
// by a caller that builds a bag of its own. `bare-http-parser` refuses it on the
// way in for the same reason.
const UNSAFE_NAMES = new Set(['__proto__'])

// RFC 9110 Content-Length = 1*DIGIT, so no sign, no whitespace, and nothing
// that `parseInt` would otherwise accept the leading digits of.
const DIGITS_RE = /^[0-9]+$/

exports.validateHeaderName = function (name) {
  if (typeof name !== 'string' || !TOKEN_RE.test(name)) {
    throw errors.INVALID_HEADER_NAME(`Invalid header name: ${JSON.stringify(name)}`)
  }

  if (UNSAFE_NAMES.has(name.toLowerCase())) {
    throw errors.INVALID_HEADER_NAME(`Unsafe header name: ${JSON.stringify(name)}`)
  }
}

exports.validateHeaderValue = function (name, value) {
  if (value === undefined) {
    throw errors.INVALID_HEADER_VALUE(`Missing header value for ${JSON.stringify(name)}`)
  }

  if (value === null) return

  // A field whose value is a list may be given as an array, in which case every
  // element goes on the wire and so every element has to be checked.
  if (Array.isArray(value)) {
    for (const element of value) exports.validateHeaderValue(name, element)
    return
  }

  exports.validateHeaderFieldValue(name, String(value))
}

exports.validateHeaderFieldValue = function (name, value) {
  if (VALUE_INVALID_RE.test(value)) {
    throw errors.INVALID_HEADER_VALUE(
      `Invalid character in header value for ${JSON.stringify(name)}`
    )
  }
}

exports.validateStatusCode = function (value) {
  if (!Number.isInteger(value) || value < 100 || value > 999) {
    throw errors.INVALID_STATUS_CODE(`Invalid status code: ${JSON.stringify(value)}`)
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

exports.validateContentLength = function (value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw errors.INVALID_CONTENT_LENGTH(`Invalid content length: ${JSON.stringify(value)}`)
    }

    return value
  }

  if (typeof value !== 'string' || !DIGITS_RE.test(value)) {
    throw errors.INVALID_CONTENT_LENGTH(`Invalid content length: ${JSON.stringify(value)}`)
  }

  const length = Number(value)

  if (!Number.isSafeInteger(length)) {
    throw errors.INVALID_CONTENT_LENGTH(`Invalid content length: ${JSON.stringify(value)}`)
  }

  return length
}
