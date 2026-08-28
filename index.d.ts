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

export type HTTPVersion = '1.0' | '1.1'

export interface HTTPInformationalResponse {
  httpVersion: HTTPVersion
  statusCode: HTTPStatusCode
  statusMessage: HTTPStatusMessage
  headers: Record<string, HTTPHeaderValue>
}

export const METHODS: HTTPMethod[]
export const STATUS_CODES: typeof constants.status

export interface HTTPIncomingMessageEvents extends ReadableEvents {
  timeout: []
}

export interface HTTPIncomingMessageOptions {
  headers?: Record<string, HTTPHeaderValue>
  httpVersion?: HTTPVersion
  method?: HTTPMethod
  url?: string
  statusCode?: HTTPStatusCode
  statusMessage?: HTTPStatusMessage
}

interface HTTPIncomingMessage<
  M extends HTTPIncomingMessageEvents = HTTPIncomingMessageEvents
> extends Readable<M> {
  readonly socket: TCPSocket
  readonly upgrade: boolean
  headers: Record<string, HTTPHeaderValue>
  method: HTTPMethod
  url: string
  statusCode: HTTPStatusCode
  statusMessage: HTTPStatusMessage
  readonly httpVersion: HTTPVersion
  readonly complete: boolean

  getHeader(name: string): HTTPHeaderValue | undefined
  getHeaders(): Record<string, HTTPHeaderValue>
  hasHeader(name: string): boolean

  setTimeout(ms: number, ontimeout?: () => void): this
}

declare class HTTPIncomingMessage<
  M extends HTTPIncomingMessageEvents = HTTPIncomingMessageEvents
> extends Readable<M> {
  constructor(socket?: TCPSocket, opts?: HTTPIncomingMessageOptions)
}

export { type HTTPIncomingMessage, HTTPIncomingMessage as IncomingMessage }

// A field whose value is a list may be given as an array, in which case it is
// sent as one field per element rather than folded onto a single line.
export type HTTPHeaderValue = string | number | (string | number)[]

// A set of fields may be given as a bag, as a flat list of alternating names
// and values, or as a list of pairs.
export type HTTPHeaders =
  Record<string, HTTPHeaderValue> | (string | HTTPHeaderValue)[] | [string, HTTPHeaderValue][]

export interface HTTPOutgoingMessageEvents extends WritableEvents {
  timeout: []
}

interface HTTPOutgoingMessage<
  M extends HTTPOutgoingMessageEvents = HTTPOutgoingMessageEvents
> extends Writable<M> {
  readonly socket: TCPSocket
  readonly upgrade: boolean
  readonly headersSent: boolean
  headers: Record<string, HTTPHeaderValue>

  getHeader(name: string): HTTPHeaderValue | undefined
  getHeaders(): Record<string, HTTPHeaderValue>
  hasHeader(name: string): boolean
  setHeader(name: string, value: HTTPHeaderValue): void
  appendHeader(name: string, value: HTTPHeaderValue): void
  flushHeaders(): void

  setTimeout(ms: number, ontimeout?: () => void): this
}

declare class HTTPOutgoingMessage<
  M extends HTTPOutgoingMessageEvents = HTTPOutgoingMessageEvents
> extends Writable<M> {
  constructor(socket?: TCPSocket)
}

export { type HTTPOutgoingMessage, HTTPOutgoingMessage as OutgoingMessage }

export interface HTTPAgentOptions {
  keepAlive?: boolean | number
  keepAliveMsecs?: number
  defaultPort?: number
}

interface HTTPAgent {
  readonly suspended: boolean
  readonly resumed: Promise<void> | null
  readonly sockets: IterableIterator<TCPSocket>
  readonly freeSockets: IterableIterator<TCPSocket>
  readonly defaultPort: number

  createConnection(opts?: TCPSocketOptions & TCPSocketConnectOptions): TCPSocket
  reuseSocket(socket: TCPSocket, req?: HTTPClientRequest): void
  keepSocketAlive(socket: TCPSocket): boolean
  getName(opts: { host: string; port: number }): string
  addRequest(req: HTTPClientRequest, opts: TCPSocketOptions & TCPSocketConnectOptions): void

  suspend(): void
  resume(): void
  destroy(): void
}

declare class HTTPAgent {
  constructor(opts?: HTTPAgentOptions & TCPSocketOptions & TCPSocketConnectOptions)
}

declare namespace HTTPAgent {
  export const global: HTTPAgent
}

export const globalAgent: HTTPAgent

export { type HTTPAgent, HTTPAgent as Agent }

export interface HTTPServerEvents extends TCPServerEvents {
  request: [req: HTTPIncomingMessage, res: HTTPServerResponse]
  checkContinue: [req: HTTPIncomingMessage, res: HTTPServerResponse]
  checkExpectation: [req: HTTPIncomingMessage, res: HTTPServerResponse]
  upgrade: [req: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
  connect: [req: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
  clientError: [err: HTTPError, socket: TCPSocket]
  timeout: [socket: TCPSocket]
}

interface HTTPServer<M extends HTTPServerEvents = HTTPServerEvents> extends TCPServer<M> {
  readonly timeout: number
  headersTimeout: number
  requestTimeout: number
  keepAliveTimeout: number
  maxHeaderSize: number
  maxHeadersCount: number
  maxUpgradeBodySize: number

  setTimeout(ms: number, ontimeout?: () => void): this

  closeIdleConnections(): void
  closeAllConnections(): void
}

declare class HTTPServer<M extends HTTPServerEvents = HTTPServerEvents> extends TCPServer<M> {
  constructor(
    opts?: HTTPServerOptions,
    onrequest?: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void
  )

  constructor(onrequest: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void)
}

export { type HTTPServer, HTTPServer as Server }

interface HTTPServerResponse extends HTTPOutgoingMessage {
  readonly req: HTTPIncomingMessage
  statusCode: HTTPStatusCode
  statusMessage: HTTPStatusMessage | null

  writeHead(
    statusCode: HTTPStatusCode,
    statusMessage?: HTTPStatusMessage,
    headers?: HTTPHeaders
  ): this

  writeHead(statusCode: HTTPStatusCode, headers?: HTTPHeaders): this

  writeContinue(): void
}

declare class HTTPServerResponse extends HTTPOutgoingMessage {
  constructor(socket: TCPSocket, req: HTTPIncomingMessage)
}

export { type HTTPServerResponse, HTTPServerResponse as ServerResponse }

export interface HTTPServerConnectionOptions {
  IncomingMessage?: typeof HTTPIncomingMessage
  ServerResponse?: typeof HTTPServerResponse
}

export interface HTTPServerOptions extends HTTPServerConnectionOptions, TCPServerOptions {
  // How long a connection may spend sending its request headers, how long the
  // whole request may take, and how long the connection is kept once a request
  // has been answered, before it is given up on. Time spent waiting on this
  // side does not count towards any of them. Zero disables them.
  headersTimeout?: number
  requestTimeout?: number
  keepAliveTimeout?: number

  // The most a peer may send before it has said anything that can be acted on.
  maxHeaderSize?: number
  maxHeadersCount?: number

  // The most of an upgrade request's body that may be held until the handover.
  // Zero disables it.
  maxUpgradeBodySize?: number
}

interface HTTPServerConnection {
  readonly server: HTTPServer
  readonly socket: TCPSocket | null
  readonly req: HTTPIncomingMessage | null
  readonly res: HTTPServerResponse | null
  readonly idle: boolean
}

declare class HTTPServerConnection {
  constructor(server: HTTPServer, socket: TCPSocket, opts?: HTTPServerConnectionOptions)

  static for(socket: TCPSocket): HTTPServerConnection
}

export { type HTTPServerConnection, HTTPServerConnection as ServerConnection }

export interface HTTPClientRequestEvents extends HTTPOutgoingMessageEvents {
  response: [res: HTTPIncomingMessage]
  information: [info: HTTPInformationalResponse]
  upgrade: [res: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
  connect: [res: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
}

export interface HTTPClientRequestOptions extends TCPSocketConnectOptions {
  agent?: HTTPAgent | false
  headers?: Record<string, HTTPHeaderValue>
  method?: HTTPMethod
  path?: string
  protocol?: string
  defaultPort?: number
}

interface HTTPClientRequest<
  M extends HTTPClientRequestEvents = HTTPClientRequestEvents
> extends HTTPOutgoingMessage<M> {
  readonly method: HTTPMethod
  readonly path: string
  readonly headers: Record<string, HTTPHeaderValue>

  // For Node.js compatibility
  abort(): void
}

declare class HTTPClientRequest<
  M extends HTTPClientRequestEvents = HTTPClientRequestEvents
> extends HTTPOutgoingMessage<M> {
  constructor(opts?: HTTPClientRequestOptions, onresponse?: () => void)

  constructor(onresponse: () => void)
}

export { type HTTPClientRequest, HTTPClientRequest as ClientRequest }

export interface HTTPClientConnectionOptions {
  IncomingMessage?: typeof HTTPIncomingMessage
}

interface HTTPClientConnection {
  readonly socket: TCPSocket | null
  readonly req: HTTPClientRequest | null
  readonly res: HTTPIncomingMessage | null
  readonly idle: boolean
}

declare class HTTPClientConnection {
  constructor(socket: TCPSocket, opts?: HTTPClientConnectionOptions)

  static for(socket: TCPSocket): HTTPClientConnection | null

  static from(socket: TCPSocket, opts?: HTTPClientConnectionOptions): HTTPClientConnection
}

export { type HTTPClientConnection, HTTPClientConnection as ClientConnection }

export function createServer(
  opts?: HTTPServerOptions,
  onrequest?: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void
): HTTPServer

export function createServer(
  onrequest: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void
): HTTPServer

export function request(
  url: URL | string,
  opts?: HTTPClientRequestOptions,
  onresponse?: (res: HTTPIncomingMessage) => void
): HTTPClientRequest

export function get(
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
