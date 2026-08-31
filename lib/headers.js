const validate = require('./validate')

// The header bags are created without a prototype so that a name that collides
// with something on `Object.prototype` can neither be mistaken for a header
// that was set nor, in the case of `__proto__`, change the bag itself.
exports.bag = function () {
  return Object.create(null)
}

// Returns a copy of the headers with every name lowercased, so that a header
// can only ever be set once no matter which casing the caller used. Sending a
// header twice is a framing hazard for anything that reads Content-Length.
exports.normalize = function (headers) {
  const normalized = exports.bag()

  if (headers) {
    for (const name of Object.keys(headers)) {
      // Validated as it was given, so that a name only a fold of case makes a
      // token is refused here as it is by `setHeader`.
      validate.validateHeaderName(name)

      const n = name.toLowerCase()

      validate.validateHeaderValue(n, headers[name])

      normalized[n] = headers[name]
    }
  }

  return normalized
}

// Only a header that was actually set counts, never one inherited from a
// prototype the bag may have been given by its creator.
exports.has = function (headers, name) {
  return Object.hasOwn(headers, name)
}

exports.get = function (headers, name) {
  return Object.hasOwn(headers, name) ? headers[name] : undefined
}

// Whether a field's value is the one token given and nothing besides. Unlike
// `hasToken` a list is refused, which for `Transfer-Encoding` is the difference
// between a body this side knows how to frame and one it does not.
exports.isToken = function (value, token) {
  if (Array.isArray(value)) return value.length === 1 && exports.isToken(value[0], token)

  return String(value).trim().toLowerCase() === token
}

// Headers such as `Connection` carry a comma separated list of tokens, which
// are case insensitive.
exports.hasToken = function (value, token) {
  if (value === undefined || value === null) return false

  if (Array.isArray(value)) {
    for (const element of value) {
      if (exports.hasToken(element, token)) return true
    }

    return false
  }

  for (const t of String(value).split(',')) {
    if (t.trim().toLowerCase() === token) return true
  }

  return false
}

// Whether these fields ask for the connection to be handed over to another
// protocol. Both the `Upgrade` header naming it and a `Connection` header
// listing the token are required, as Node.js requires: going on the latter
// alone would let an ordinary message take the socket away from its consumer.
exports.isUpgrading = function (headers) {
  return (
    exports.has(headers, 'upgrade') &&
    exports.hasToken(exports.get(headers, 'connection'), 'upgrade')
  )
}

// Whether a peer that sent these fields means to close the connection once the
// message is done. HTTP/1.0 has no persistent connections unless the peer asks
// for them, and a peer of any version may bow out with `Connection: close`.
exports.isClosing = function (headers, httpVersion) {
  const connection = exports.get(headers, 'connection')

  if (exports.hasToken(connection, 'close')) return true

  return httpVersion === '1.0' && exports.hasToken(connection, 'keep-alive') === false
}

// Serializes one field into the one or more lines it occupies. A value given as
// an array is a list, and a list is repeated across lines rather than folded
// onto one, because `Set-Cookie` cannot be folded at all: its own value
// contains the commas that would otherwise separate the elements. `Cookie` is
// the exception, as its list separator is `; ` and it may only appear once.
exports.serialize = function (name, value) {
  const n = httpCase(name)

  if (Array.isArray(value)) {
    if (value.length === 0) return ''

    const elements = new Array(value.length)

    for (let i = 0, m = value.length; i < m; i++) elements[i] = toField(name, value[i])

    if (isCookie(name) && elements.length > 1) return n + ': ' + elements.join('; ') + '\r\n'

    let s = ''

    for (const element of elements) s += n + ': ' + element + '\r\n'

    return s
  }

  return n + ': ' + toField(name, value) + '\r\n'
}

function toField(name, value) {
  value = String(value)

  validate.validateHeaderFieldValue(name, value)

  return value
}

function isCookie(name) {
  return name.toLowerCase() === 'cookie'
}

function httpCase(name) {
  const parts = name.split('-')

  for (let i = 0, n = parts.length; i < n; i++) {
    parts[i] = parts[i].slice(0, 1).toUpperCase() + parts[i].slice(1)
  }

  return parts.join('-')
}
