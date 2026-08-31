import { Readable, ReadableEvents, Writable, WritableEvents } from 'bare-stream'
import {
  TCPSocket,
  TCPSocketOptions,
  TCPSocketConnectOptions,
  TCPServer,
  TCPServerEvents,
  TCPServerOptions
} from 'bare-tcp'
import Buffer from 'bare-buffer'
import URL from 'bare-url'
import constants, { HTTPMethod, HTTPStatusCode, HTTPStatusMessage } from './lib/constants'
import HTTPError from './lib/errors'

export {
  constants,
  type HTTPMethod,
  type HTTPStatusCode,
  type HTTPStatusMessage,
  type HTTPError,
  HTTPError as errors
}

/** The HTTP version of a message, either `'1.0'` or `'1.1'`. */
export type HTTPVersion = '1.0' | '1.1'

/**
 * The value of a header as it arrived, which is only ever a list where the field may appear more
 * than once and cannot be folded onto one line.
 */
export type HTTPIncomingHeaderValue = string | string[]

/**
 * An interim 1xx response received ahead of the final one, carried by the `'information'` event of
 * an `HTTPClientRequest`.
 */
export interface HTTPInformationalResponse {
  httpVersion: HTTPVersion
  statusCode: HTTPStatusCode
  statusMessage: HTTPStatusMessage
  headers: Record<string, HTTPIncomingHeaderValue>
}

/** The list of all supported HTTP method names. */
export const METHODS: HTTPMethod[]
/** An alias for `constants.status`, mapping status codes to their reason phrases. */
export const STATUS_CODES: typeof constants.status

/**
 * The events an `HTTPIncomingMessage` emits in addition to the underlying readable stream's events:
 * `timeout`, when the socket times out.
 */
export interface HTTPIncomingMessageEvents extends ReadableEvents {
  /** Emitted when the underlying socket times out. */
  timeout: []
}

/**
 * Options for constructing an `HTTPIncomingMessage` directly: initial `headers`, the `httpVersion`
 * it arrived as, `method` and `url` (server-side), and `statusCode`/`statusMessage` (client-side).
 */
export interface HTTPIncomingMessageOptions {
  headers?: Record<string, HTTPIncomingHeaderValue>
  /** The HTTP version the message arrived as. Defaults to `'1.1'`. */
  httpVersion?: HTTPVersion
  method?: HTTPMethod
  /** The request URL path. Only meaningful on the server side. */
  url?: string
  statusCode?: HTTPStatusCode
  statusMessage?: HTTPStatusMessage
}

interface HTTPIncomingMessage<
  M extends HTTPIncomingMessageEvents = HTTPIncomingMessageEvents
> extends Readable<M> {
  /** The underlying `TCPSocket` the message was read from, or `null` once it has been given up. */
  readonly socket: TCPSocket | null
  /** Whether the connection was upgraded (for example to a WebSocket) after this message. */
  readonly upgrade: boolean
  /**
   * The parsed headers, keyed by lowercase name. A field that appeared more than once and cannot be
   * folded onto one line is given as a list.
   */
  headers: Record<string, HTTPIncomingHeaderValue>
  /** The request method. Only meaningful on the server side. */
  method: HTTPMethod
  /** The request URL path. Only meaningful on the server side. */
  url: string
  /** The response status code. Only meaningful on the client side. */
  statusCode: HTTPStatusCode
  /** The response status reason phrase. Only meaningful on the client side. */
  statusMessage: HTTPStatusMessage
  /** The HTTP version the message arrived as. */
  readonly httpVersion: HTTPVersion
  /**
   * Whether the whole of the message arrived, as against the peer having gone away part way through
   * it. The stream closes either way, so this is what tells a consumer which of the two it was
   * handed.
   */
  readonly complete: boolean

  /**
   * Returns the value of header `name` (case-insensitive), or `undefined` if not set.
   * @param name - The header name (case-insensitive).
   */
  getHeader(name: string): HTTPIncomingHeaderValue | undefined
  /** Returns a shallow copy of all headers. */
  getHeaders(): Record<string, HTTPIncomingHeaderValue>
  /**
   * Returns whether header `name` (case-insensitive) is set.
   * @param name - The header name (case-insensitive).
   */
  hasHeader(name: string): boolean

  /**
   * Sets the underlying socket's timeout to `ms` and, if given, adds `ontimeout` as a one-time
   * `'timeout'` listener.
   * @param ms - The socket timeout in milliseconds.
   * @param ontimeout - Added as a one-time `'timeout'` listener.
   */
  setTimeout(ms: number, ontimeout?: () => void): this
}

declare class HTTPIncomingMessage<
  M extends HTTPIncomingMessageEvents = HTTPIncomingMessageEvents
> extends Readable<M> {
  /**
   * A readable stream representing an incoming HTTP request (on the server) or response (on the
   * client). Carries the parsed `headers`, `method`/`url` or `statusCode`/`statusMessage`, and the
   * underlying `socket`.
   * @param socket - The socket the message is read from.
   * @param opts - Initial values for `headers` and `httpVersion`, plus `method` and `url` (server
   * side) or `statusCode` and `statusMessage` (client side).
   */
  constructor(socket?: TCPSocket, opts?: HTTPIncomingMessageOptions)
}

export { type HTTPIncomingMessage, HTTPIncomingMessage as IncomingMessage }

/**
 * The value of a header to send. A field whose value is a list may be given as an array, in which
 * case it is sent as one field per element rather than folded onto a single line. `Cookie` is the
 * exception, whose elements are folded onto a single line separated by `'; '`. A value of `null` is
 * sent as the string it coerces to, as Node.js sends it.
 */
export type HTTPHeaderValue = string | number | null | (string | number | null)[]

/**
 * A set of headers to send, given as a bag, as a flat list of alternating names and values, or as a
 * list of pairs.
 */
export type HTTPHeaders =
  Record<string, HTTPHeaderValue> | (string | HTTPHeaderValue)[] | [string, HTTPHeaderValue][]

/**
 * The events an `HTTPOutgoingMessage` emits in addition to the underlying writable stream's events:
 * `timeout`, when the socket times out.
 */
export interface HTTPOutgoingMessageEvents extends WritableEvents {
  /** Emitted when the underlying socket times out. */
  timeout: []
}

interface HTTPOutgoingMessage<
  M extends HTTPOutgoingMessageEvents = HTTPOutgoingMessageEvents
> extends Writable<M> {
  /** The underlying `TCPSocket` the message is written to, or `null` until one is assigned. */
  readonly socket: TCPSocket | null
  /** Whether the connection was upgraded (for example to a WebSocket) after this message. */
  readonly upgrade: boolean
  /** Whether the headers have already been sent. */
  readonly headersSent: boolean
  /**
   * The headers set so far, keyed by lowercase name. Assigning validates each header name and
   * value.
   */
  headers: Record<string, HTTPHeaderValue>

  /**
   * Returns the value of header `name` (case-insensitive), or `undefined` if not set.
   * @param name - The header name (case-insensitive).
   */
  getHeader(name: string): HTTPHeaderValue | undefined
  /** Returns a shallow copy of all headers set so far. */
  getHeaders(): Record<string, HTTPHeaderValue>
  /**
   * Returns whether header `name` (case-insensitive) is set.
   * @param name - The header name (case-insensitive).
   */
  hasHeader(name: string): boolean
  /**
   * Sets header `name` (case-insensitive) to `value`, replacing any value already set and
   * validating both.
   * @param name - The header name (case-insensitive); must be a valid RFC 9110 token, and must not
   * be `__proto__`.
   * @param value - The header value; must not contain a control character other than tab. Every
   * element of an array value is checked in turn, and `null` is allowed.
   * @throws {HEADERS_SENT} the headers have already been sent.
   * @throws {INVALID_HEADER_NAME} `name` is not a valid RFC 9110 token, or is `__proto__`.
   * @throws {INVALID_HEADER_VALUE} `value` is `undefined`, or contains a control character other
   * than tab.
   */
  setHeader(name: string, value: HTTPHeaderValue): void
  /**
   * Adds `value` to header `name` (case-insensitive), keeping any value already set rather than
   * replacing it, so that the field is sent once per value. `Cookie` is the exception, whose values
   * are folded onto a single line separated by `'; '`.
   * @param name - The header name (case-insensitive); must be a valid RFC 9110 token, and must not
   * be `__proto__`.
   * @param value - The header value; must not contain a control character other than tab. Every
   * element of an array value is checked in turn, and `null` is allowed.
   * @throws {HEADERS_SENT} the headers have already been sent.
   * @throws {INVALID_HEADER_NAME} `name` is not a valid RFC 9110 token, or is `__proto__`.
   * @throws {INVALID_HEADER_VALUE} `value` is `undefined`, or contains a control character other
   * than tab.
   */
  appendHeader(name: string, value: HTTPHeaderValue): void
  /**
   * Sends the headers immediately, if they haven't already been sent, instead of waiting for the
   * first write.
   */
  flushHeaders(): void

  /**
   * Sets the underlying socket's timeout to `ms` and, if given, adds `ontimeout` as a one-time
   * `'timeout'` listener.
   * @param ms - The socket timeout in milliseconds.
   * @param ontimeout - Added as a one-time `'timeout'` listener.
   */
  setTimeout(ms: number, ontimeout?: () => void): this
}

declare class HTTPOutgoingMessage<
  M extends HTTPOutgoingMessageEvents = HTTPOutgoingMessageEvents
> extends Writable<M> {
  /**
   * A writable stream representing an outgoing HTTP request (on the client) or response (on the
   * server). Base class of `HTTPClientRequest` and `HTTPServerResponse`.
   * @param socket - The socket the message is written to.
   */
  constructor(socket?: TCPSocket)
}

export { type HTTPOutgoingMessage, HTTPOutgoingMessage as OutgoingMessage }

/** Options for `HTTPAgent`. */
export interface HTTPAgentOptions {
  /**
   * Whether to keep sockets open for reuse once a request completes, either `true` (using
   * `keepAliveMsecs`) or a number of milliseconds. Defaults to `false`.
   */
  keepAlive?: boolean | number
  /** The keep-alive duration in milliseconds when `keepAlive` is `true`. Defaults to `1000`. */
  keepAliveMsecs?: number
  /** The port used for a request that names none. Defaults to `80`. */
  defaultPort?: number

  /**
   * How many sockets the agent may hold at once for a single origin. A request the agent has no
   * room to open one for waits until one comes free. Defaults to `Infinity`.
   */
  maxSockets?: number
  /**
   * How many sockets the agent may hold at once across every origin it talks to. A request the
   * agent has no room to open one for waits until one comes free. Defaults to `Infinity`.
   */
  maxTotalSockets?: number

  /**
   * How many sockets the agent may keep in its pool for a single origin once they are no longer in
   * use. Defaults to `256`.
   */
  maxFreeSockets?: number
}

interface HTTPAgent {
  /** Whether the agent is currently suspended. */
  readonly suspended: boolean
  /**
   * A promise that resolves once a suspended agent is resumed, or `null` if the agent isn't
   * suspended.
   */
  readonly resumed: Promise<void> | null
  /** An iterator over all sockets currently held by the agent, both in-use and free. */
  readonly sockets: IterableIterator<TCPSocket>
  /** An iterator over the agent's idle, keep-alive sockets awaiting reuse. */
  readonly freeSockets: IterableIterator<TCPSocket>
  /** The port used for a request that names none. */
  readonly defaultPort: number
  /** Whether the agent keeps sockets open for reuse once a request completes. */
  readonly keepAlive: boolean

  /** How many sockets the agent may hold at once for a single origin. */
  maxSockets: number
  /** How many sockets the agent may keep in its pool for a single origin once they are free. */
  maxFreeSockets: number
  /** How many sockets the agent may hold at once across every origin it talks to. */
  maxTotalSockets: number

  /**
   * Creates a new `TCPSocket` connection for a request. Throws if the agent is suspended.
   * @param opts - The socket and connection options, including the destination `host` and `port`.
   * @throws {AGENT_SUSPENDED} the agent is suspended.
   */
  createConnection(opts?: TCPSocketOptions & TCPSocketConnectOptions): TCPSocket
  /**
   * Marks `socket` as back in active use, referencing it so it keeps the event loop alive.
   * @param socket - The socket to mark as back in active use.
   * @param req - The request the socket is being reused for.
   */
  reuseSocket(socket: TCPSocket, req?: HTTPClientRequest): void
  /**
   * Marks `socket` to be kept alive and unreferenced instead of closed once a request completes.
   * Returns whether the socket was kept alive.
   * @param socket - The socket to keep alive for reuse.
   */
  keepSocketAlive(socket: TCPSocket): boolean
  /**
   * Returns the pool key used to group sockets by destination, derived from `opts.host`,
   * `opts.port`, `opts.localAddress`, `opts.family`, and `opts.socketPath`.
   * @param opts - The connection options to derive the pool key from.
   */
  getName(opts: TCPSocketConnectOptions): string
  /**
   * Assigns a socket to `req`, reusing an idle keep-alive socket for the same origin if one is
   * available, creating a new one if there is room, and queueing the request until one comes free
   * otherwise.
   * @param req - The request to assign a socket to.
   * @param opts - The socket and connection options, including the destination `host` and `port`.
   */
  addRequest(req: HTTPClientRequest, opts: TCPSocketOptions & TCPSocketConnectOptions): void

  /**
   * Suspends the agent, destroying all its sockets and preventing new connections until `resume()`
   * is called.
   */
  suspend(): void
  /** Resumes an agent suspended with `suspend()`, allowing it to create connections again. */
  resume(): void
  /** Destroys all sockets currently held by the agent, both in-use and free. */
  destroy(): void
}

declare class HTTPAgent {
  /**
   * Manages a pool of `TCPSocket` connections shared across requests to the same origin, reusing
   * idle keep-alive sockets instead of opening a new connection per request.
   * @param opts - Agent options (`keepAlive`, `keepAliveMsecs`, `defaultPort`, `maxSockets`,
   * `maxTotalSockets`, `maxFreeSockets`) plus TCP socket and connect options applied to each
   * connection the agent creates.
   */
  constructor(opts?: HTTPAgentOptions & TCPSocketOptions & TCPSocketConnectOptions)
}

declare namespace HTTPAgent {
  /** The agent's own default instance, used as `bare-http1`'s `globalAgent`. */
  export const global: HTTPAgent
}

/** The default `HTTPAgent` used by `request()` and `get()` when no `agent` option is given. */
export const globalAgent: HTTPAgent

export { type HTTPAgent, HTTPAgent as Agent }

/**
 * The events an `HTTPServer` emits in addition to the underlying TCP server's events: `request`,
 * for each incoming request; `checkContinue` and `checkExpectation`, for a request that announced
 * an expectation; `upgrade` and `connect`, when a connection is handed over; `clientError`, when a
 * connection fails; `timeout`, when a connection's socket times out.
 */
export interface HTTPServerEvents extends TCPServerEvents {
  /**
   * Emitted for each request received, with the `HTTPIncomingMessage` for the request and the
   * `HTTPServerResponse` for the reply.
   */
  request: [req: HTTPIncomingMessage, res: HTTPServerResponse]
  /**
   * Emitted instead of `'request'` when a request carries `Expect: 100-continue` and a listener is
   * attached, letting the handler call `res.writeContinue()` or refuse the body itself. Without a
   * listener the continue is sent automatically and `'request'` is emitted.
   */
  checkContinue: [req: HTTPIncomingMessage, res: HTTPServerResponse]
  /**
   * Emitted instead of `'request'` when a request carries an `Expect` header other than
   * `100-continue` and a listener is attached. Without a listener the request is answered with
   * `417 Expectation Failed`.
   */
  checkExpectation: [req: HTTPIncomingMessage, res: HTTPServerResponse]
  /**
   * Emitted when a request asks to upgrade the protocol, with the socket and any bytes already read
   * past the request. The socket is destroyed if the event has no listener.
   */
  upgrade: [req: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
  /**
   * Emitted for a `CONNECT` request, with the socket and any bytes already read past the request.
   * The socket is destroyed if the event has no listener.
   */
  connect: [req: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
  /**
   * Emitted when a connection fails, for example on a malformed request. Without a listener the
   * server answers with an error response of its own before taking the connection down.
   */
  clientError: [err: HTTPError, socket: TCPSocket]
  timeout: [socket: TCPSocket]
}

interface HTTPServer<M extends HTTPServerEvents = HTTPServerEvents> extends TCPServer<M> {
  /** The idle-socket timeout in milliseconds. Defaults to `0`, meaning no timeout. */
  readonly timeout: number
  /**
   * How long a connection may spend sending its request headers, in milliseconds, before it is
   * given up on. Defaults to `60000`; zero disables it.
   */
  headersTimeout: number
  /**
   * How long a whole request may take, in milliseconds, before it is given up on. Defaults to
   * `300000`; zero disables it.
   */
  requestTimeout: number
  /**
   * How long a connection is kept once a request has been answered, in milliseconds, before it is
   * given up on. Defaults to `5000`; zero disables it.
   */
  keepAliveTimeout: number
  /**
   * The most a peer may send in a request line and headers before the request can be acted on.
   * Defaults to `16384`; zero disables it.
   */
  maxHeaderSize: number
  /**
   * The most headers a peer may send in a request. Defaults to `2000`; zero disables it.
   */
  maxHeadersCount: number
  /**
   * The most of an upgrade request's body that may be held until the handover. Defaults to `65536`;
   * zero disables it.
   */
  maxUpgradeBodySize: number

  /**
   * Sets the idle-socket timeout to `ms` (default `0`, meaning no timeout) and, if given, adds
   * `ontimeout` as a `'timeout'` listener.
   * @param ms - The idle-socket timeout in milliseconds; `0` (the default) disables it.
   * @param ontimeout - Added as a `'timeout'` listener.
   */
  setTimeout(ms: number, ontimeout?: () => void): this

  /** Destroys every connection that has no request in flight. */
  closeIdleConnections(): void
  /** Destroys every connection, in flight or not. */
  closeAllConnections(): void
}

declare class HTTPServer<M extends HTTPServerEvents = HTTPServerEvents> extends TCPServer<M> {
  /**
   * An HTTP/1.1 server, extending `TCPServer`. Emits `'request'` with an `HTTPIncomingMessage` and
   * `HTTPServerResponse` for each request received.
   * @param opts - Server options, including the connection timeouts and limits, TCP server options,
   * and custom `IncomingMessage` and `ServerResponse` classes.
   * @param onrequest - Added as a listener for the `'request'` event.
   */
  constructor(
    opts?: HTTPServerOptions,
    onrequest?: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void
  )

  constructor(onrequest: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void)
}

export { type HTTPServer, HTTPServer as Server }

interface HTTPServerResponse extends HTTPOutgoingMessage {
  /** The `HTTPIncomingMessage` this response is answering. */
  readonly req: HTTPIncomingMessage
  /** The response status code to send. Defaults to `200`. */
  statusCode: HTTPStatusCode
  /**
   * The response status reason phrase to send, or `null` to use the standard phrase for
   * `statusCode`.
   */
  statusMessage: HTTPStatusMessage | null

  /**
   * Sets `statusCode`, and optionally `statusMessage` and additional `headers`, in one call.
   * @param statusCode - The status code to send.
   * @param statusMessage - The reason phrase to send; defaults to the standard phrase for
   * `statusCode`.
   * @param headers - Additional headers to merge into the response headers.
   * @throws {HEADERS_SENT} the headers have already been sent.
   * @throws {INVALID_STATUS_CODE} `statusCode` is not a valid status code.
   * @throws {INVALID_HEADER_NAME} a header name is not a valid token.
   * @throws {INVALID_HEADER_VALUE} `statusMessage` or a header value contains an invalid character.
   */
  writeHead(
    statusCode: HTTPStatusCode,
    statusMessage?: HTTPStatusMessage,
    headers?: HTTPHeaders
  ): this

  writeHead(statusCode: HTTPStatusCode, headers?: HTTPHeaders): this

  /**
   * Sends a `100 Continue` interim response, telling a client that announced `Expect: 100-continue`
   * to go ahead and send its body.
   * @throws {HEADERS_SENT} the headers have already been sent.
   */
  writeContinue(): void
}

/** Options for `HTTPServerResponse`. */
export interface HTTPServerResponseOptions {
  /**
   * How long the connection the response goes out on is kept once it is done with, in milliseconds,
   * which the peer is told so that it does not send another request into one that is about to be
   * reclaimed. Defaults to `0`.
   */
  keepAliveTimeout?: number
}

declare class HTTPServerResponse extends HTTPOutgoingMessage {
  /**
   * An outgoing HTTP response, extending `HTTPOutgoingMessage`. Defaults to status `200` and
   * chunked transfer encoding unless a `Content-Length` header is set or the request was HTTP/1.0.
   * @param socket - The socket the response is written to.
   * @param req - The request this response answers.
   * @param opts - The `keepAliveTimeout` to advertise to the peer.
   */
  constructor(socket: TCPSocket, req: HTTPIncomingMessage, opts?: HTTPServerResponseOptions)
}

export { type HTTPServerResponse, HTTPServerResponse as ServerResponse }

/**
 * Options for `HTTPServerConnection`, letting custom `IncomingMessage` and `ServerResponse`
 * subclasses be used for requests handled on the connection.
 */
export interface HTTPServerConnectionOptions {
  IncomingMessage?: typeof HTTPIncomingMessage
  ServerResponse?: typeof HTTPServerResponse
}

/**
 * Options for `HTTPServer`, extending the `HTTPServerConnection` and `TCPServer` options with the
 * timeouts and limits applied to each connection.
 */
export interface HTTPServerOptions extends HTTPServerConnectionOptions, TCPServerOptions {
  /**
   * How long a connection may spend sending its request headers, in milliseconds, before it is
   * given up on. Time spent waiting on this side does not count towards it. Defaults to `60000`;
   * zero disables it.
   */
  headersTimeout?: number
  /**
   * How long a whole request may take, in milliseconds, before it is given up on. Time spent
   * waiting on this side does not count towards it. Defaults to `300000`; zero disables it.
   */
  requestTimeout?: number
  /**
   * How long a connection is kept once a request has been answered, in milliseconds, before it is
   * given up on. Defaults to `5000`; zero disables it.
   */
  keepAliveTimeout?: number

  /**
   * The most a peer may send in a request line and headers before it has said anything that can be
   * acted on. Defaults to `16384`; zero disables it.
   */
  maxHeaderSize?: number
  /**
   * The most headers a peer may send before it has said anything that can be acted on. Defaults to
   * `2000`; zero disables it.
   */
  maxHeadersCount?: number

  /**
   * The most of an upgrade request's body that may be held until the handover. Defaults to `65536`;
   * zero disables it.
   */
  maxUpgradeBodySize?: number
}

interface HTTPServerConnection {
  /** The `HTTPServer` this connection belongs to. */
  readonly server: HTTPServer
  /** The underlying `TCPSocket` for this connection. */
  readonly socket: TCPSocket | null
  /** The `HTTPIncomingMessage` currently being read on this connection, or `null` if none. */
  readonly req: HTTPIncomingMessage | null
  /** The `HTTPServerResponse` currently being written on this connection, or `null` if none. */
  readonly res: HTTPServerResponse | null
  /** Whether the connection currently has no in-flight request. */
  readonly idle: boolean
}

declare class HTTPServerConnection {
  /**
   * The per-socket state machine that parses incoming request data into
   * `HTTPIncomingMessage`/`HTTPServerResponse` pairs for an `HTTPServer`.
   * @param server - The server the connection belongs to.
   * @param socket - The connection socket.
   * @param opts - Custom `IncomingMessage` and `ServerResponse` classes to use for requests on the
   * connection.
   */
  constructor(server: HTTPServer, socket: TCPSocket, opts?: HTTPServerConnectionOptions)

  /**
   * Returns the `HTTPServerConnection` associated with `socket`, or `null` if none exists.
   * @param socket - The socket to look up.
   */
  static for(socket: TCPSocket): HTTPServerConnection | null
}

export { type HTTPServerConnection, HTTPServerConnection as ServerConnection }

/**
 * The events an `HTTPClientRequest` emits in addition to the underlying writable stream's events:
 * `response`, with the `HTTPIncomingMessage` reply; `continue` and `information`, for an interim
 * 1xx response; `upgrade` and `connect`, when the connection is handed over.
 */
export interface HTTPClientRequestEvents extends HTTPOutgoingMessageEvents {
  response: [res: HTTPIncomingMessage]
  /**
   * Emitted on any `100 Continue` received, which for a request that announced
   * `Expect: 100-continue` means the body may be sent. Emitted ahead of the `'information'` event
   * the same response also drives.
   */
  continue: []
  /** Emitted for each interim 1xx response received ahead of the final one. */
  information: [info: HTTPInformationalResponse]
  /**
   * Emitted when the server agrees to upgrade the protocol, with the socket and any bytes already
   * read past the response. The socket is destroyed if the event has no listener.
   */
  upgrade: [res: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
  /**
   * Emitted when the server answers a `CONNECT` request, with the socket and any bytes already read
   * past the response. The socket is destroyed if the event has no listener.
   */
  connect: [res: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
}

/** Options for `HTTPClientRequest`, extending the TCP connect options with the request itself. */
export interface HTTPClientRequestOptions extends TCPSocketConnectOptions {
  /** The agent to pool the connection with, or `false` for a fresh, unpooled one. */
  agent?: HTTPAgent | false

  /**
   * Credentials of the form `user:password`, sent as an `Authorization` header unless one is
   * already set.
   */
  auth?: string

  headers?: Record<string, HTTPHeaderValue>
  /** The request method. Defaults to `'GET'`. */
  method?: HTTPMethod
  /** The request path. Defaults to `'/'`. */
  path?: string
  /** The protocol to request over. Only `'http:'` and `'ws:'` are supported. */
  protocol?: string
  /** The port to use when none is given. Defaults to the agent's default port. */
  defaultPort?: number
}

interface HTTPClientRequest<
  M extends HTTPClientRequestEvents = HTTPClientRequestEvents
> extends HTTPOutgoingMessage<M> {
  /** The request method. Defaults to `'GET'`. */
  readonly method: HTTPMethod
  /** The request path. Defaults to `'/'`. */
  readonly path: string
  /**
   * The headers to send with the request, keyed by lowercase name, including an auto-generated
   * `host` header.
   */
  readonly headers: Record<string, HTTPHeaderValue>

  /** Destroys the request. An alias of `destroy()`, for Node.js compatibility. */
  abort(): void
}

declare class HTTPClientRequest<
  M extends HTTPClientRequestEvents = HTTPClientRequestEvents
> extends HTTPOutgoingMessage<M> {
  /**
   * An outgoing HTTP request, extending `HTTPOutgoingMessage`. Uses chunked transfer encoding
   * unless a `Content-Length` header is set or the method is `GET`/`HEAD`.
   * @param opts - Request options; `method` defaults to `'GET'`, `path` to `'/'`, `host` to
   * `'localhost'`, and `port` to `defaultPort` or the agent's default port (`80`). Set `agent` to
   * choose the pooling agent, or `false` for a fresh, unpooled one.
   * @param onresponse - Added as a one-time `'response'` listener.
   * @throws {INVALID_HEADER_NAME} `method` or a header name is not a valid token.
   * @throws {INVALID_HEADER_VALUE} `host` is not a string, or `path` or a header value contains an
   * invalid character.
   */
  constructor(opts?: HTTPClientRequestOptions, onresponse?: (res: HTTPIncomingMessage) => void)

  constructor(onresponse: (res: HTTPIncomingMessage) => void)
}

export { type HTTPClientRequest, HTTPClientRequest as ClientRequest }

/**
 * Options for `HTTPClientConnection`, letting a custom `IncomingMessage` subclass be used for the
 * response.
 */
export interface HTTPClientConnectionOptions {
  IncomingMessage?: typeof HTTPIncomingMessage
}

interface HTTPClientConnection {
  /** The underlying `TCPSocket` for this connection. */
  readonly socket: TCPSocket | null
  /** The `HTTPClientRequest` currently in flight on this connection, or `null` if none. */
  readonly req: HTTPClientRequest | null
  /** The `HTTPIncomingMessage` currently being read on this connection, or `null` if none. */
  readonly res: HTTPIncomingMessage | null
  /** Whether the connection currently has no in-flight request. */
  readonly idle: boolean

  /**
   * How long the peer said it holds the connection open for, in milliseconds, or `-1` when it said
   * nothing.
   */
  readonly keepAliveTimeout: number
}

declare class HTTPClientConnection {
  /**
   * The per-socket state machine that parses response data for an `HTTPClientRequest`, and drives
   * its `'response'` event.
   * @param socket - The connection socket.
   * @param opts - A custom `IncomingMessage` class to use for the response.
   */
  constructor(socket: TCPSocket, opts?: HTTPClientConnectionOptions)

  /**
   * Returns the `HTTPClientConnection` associated with `socket`, or `null` if none exists.
   * @param socket - The socket to look up.
   */
  static for(socket: TCPSocket): HTTPClientConnection | null

  /**
   * Returns the existing `HTTPClientConnection` for `socket`, creating one with `opts` if none
   * exists yet.
   * @param socket - The socket to look up or create a connection for.
   * @param opts - Options used if a new connection is created.
   */
  static from(socket: TCPSocket, opts?: HTTPClientConnectionOptions): HTTPClientConnection
}

export { type HTTPClientConnection, HTTPClientConnection as ClientConnection }

/**
 * Creates an `HTTPServer`. If `onrequest` is given, it's added as a `'request'` listener.
 * @param opts - Server options, including the connection timeouts and limits, TCP server options,
 * and custom `IncomingMessage` and `ServerResponse` classes.
 * @param onrequest - Added as a listener for the `'request'` event.
 */
export function createServer(
  opts?: HTTPServerOptions,
  onrequest?: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void
): HTTPServer

export function createServer(
  onrequest: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void
): HTTPServer

/**
 * Creates an `HTTPClientRequest` to `url` (a `URL` or a URL string) or to the destination named by
 * `opts`. The request is not ended, so a body can be written before calling `end()`. If
 * `onresponse` is given, it's added as a one-time `'response'` listener.
 * @param url - The URL to request, as a `URL` object or string; its protocol, host, port, path, and
 * credentials are defaults that `opts` may override.
 * @param opts - Request options, merged over the values derived from `url`.
 * @param onresponse - Added as a one-time `'response'` listener.
 * @throws {INVALID_PROTOCOL} a protocol is given and is neither `'http:'` nor `'ws:'`.
 */
export function request(
  url: URL | string,
  opts?: HTTPClientRequestOptions,
  onresponse?: (res: HTTPIncomingMessage) => void
): HTTPClientRequest

export function request(
  url: URL | string,
  onresponse: (res: HTTPIncomingMessage) => void
): HTTPClientRequest

export function request(
  opts: HTTPClientRequestOptions,
  onresponse?: (res: HTTPIncomingMessage) => void
): HTTPClientRequest

/**
 * Like `request()`, but ends the request immediately, since GET requests have no body.
 * @param url - The URL to request, as a `URL` object or string; its protocol, host, port, path, and
 * credentials are defaults that `opts` may override.
 * @param opts - Request options, merged over the values derived from `url`.
 * @param onresponse - Added as a one-time `'response'` listener.
 * @throws {INVALID_PROTOCOL} a protocol is given and is neither `'http:'` nor `'ws:'`.
 */
export function get(
  url: URL | string,
  opts?: HTTPClientRequestOptions,
  onresponse?: (res: HTTPIncomingMessage) => void
): HTTPClientRequest

export function get(
  url: URL | string,
  onresponse: (res: HTTPIncomingMessage) => void
): HTTPClientRequest

export function get(
  opts: HTTPClientRequestOptions,
  onresponse?: (res: HTTPIncomingMessage) => void
): HTTPClientRequest
