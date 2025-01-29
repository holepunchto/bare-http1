import { Readable, ReadableEvents, Writable, WritableEvents } from 'bare-stream'
import {
  TCPSocket,
  TCPSocketOptions,
  TCPSocketConnectOptions,
  TCPServer,
  TCPServerEvents
} from 'bare-tcp'
import Buffer from 'bare-buffer'
import URL from 'bare-url'
import constants, {
  HTTPMethod,
  HTTPStatusCode,
  HTTPStatusMessage
} from './lib/constants'

interface HTTPIncomingMessageEvents extends ReadableEvents {
  timeout: []
}

interface HTTPIncomingMessageOptions {
  method?: HTTPMethod
  url?: URL | string
  statusCode?: HTTPStatusCode
  statusMessage?: HTTPStatusMessage
}

declare class HTTPIncomingMessage extends Readable<HTTPIncomingMessageEvents> {
  constructor(
    socket?: TCPSocket,
    headers?: Record<string, string | number>,
    opts?: HTTPIncomingMessageOptions
  )

  readonly socket: TCPSocket
  readonly headers: Record<string, string | number>
  readonly upgrade: boolean

  readonly method: HTTPMethod
  readonly url: URL | string

  readonly statusCode: HTTPStatusCode
  readonly statusMessage: HTTPStatusMessage

  readonly httpVersion: '1.1'

  getHeader(name: string): string | number | undefined
  getHeaders(): Record<string, string | number>
  hasHeader(name: string): boolean

  setTimeout(ms: number, ontimeout?: () => void): this
}

interface HTTPOutgoingMessageEvents extends WritableEvents {
  timeout: []
}

declare class HTTPOutgoingMessage<
  M extends HTTPOutgoingMessageEvents = HTTPOutgoingMessageEvents
> extends Writable<M> {
  constructor(socket?: TCPSocket)

  readonly socket: TCPSocket
  readonly headers: Record<string, string | number>
  readonly headersSent: boolean
  readonly upgrade: boolean

  getHeader(name: string): string | number | undefined
  getHeaders(): Record<string, string | number>
  hasHeader(name: string): boolean
  setHeader(name: string, value: string | number): void
  flushHeaders(): void

  setTimeout(ms: number, ontimeout?: () => void): this
}

interface HTTPAgentOptions {
  keepAlive?: boolean
  keepAliveMsecs?: number
}

declare class HTTPAgent {
  constructor(
    opts?: HTTPAgentOptions & TCPSocketOptions & TCPSocketConnectOptions
  )

  createConnection(opts?: TCPSocketOptions & TCPSocketConnectOptions): TCPSocket

  reuseSocket(socket: TCPSocket, req?: HTTPClientRequest): void

  keepSocketAlive(socket: TCPSocket): boolean

  getName(opts: { host: string; port: number }): string

  addRequest(
    req: HTTPClientRequest,
    opts: TCPSocketOptions & TCPSocketConnectOptions
  ): void

  destroy(): void

  static global: HTTPAgent
}

interface HTTPServerEvents extends TCPServerEvents {
  request: [req: HTTPIncomingMessage, res: HTTPServerResponse]
  upgrade: [req: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
  timeout: [socket: TCPSocket]
}

declare class HTTPServer<
  M extends HTTPServerEvents = HTTPServerEvents
> extends TCPServer<M> {
  constructor(
    opts?: HTTPServerConnectionOptions,
    onrequest?: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void
  )
  constructor(
    onrequest: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void
  )

  readonly timeout: number | undefined

  setTimeout(ms: number, ontimeout?: () => void): this
}

declare class HTTPServerResponse extends HTTPOutgoingMessage {
  constructor(socket: TCPSocket, req: HTTPIncomingMessage, close: boolean)

  readonly req: HTTPIncomingMessage
  readonly statusCode: HTTPStatusCode
  readonly statusMessage: HTTPStatusMessage | null

  writeHead(
    statusCode: HTTPStatusCode,
    statusMessage?: HTTPStatusMessage,
    headers?: Record<string, string | number>
  ): void

  writeHead(
    statusCode: HTTPStatusCode,
    headers?: Record<string, string | number>
  ): void
}

interface HTTPServerConnectionOptions {
  IncomingMessage?: typeof HTTPIncomingMessage
  ServerResponse?: typeof HTTPServerResponse
}

declare class HTTPServerConnection {
  constructor(
    server: HTTPServer,
    socket: TCPSocket,
    opts?: HTTPServerConnectionOptions
  )

  readonly server: HTTPServer
  readonly socket: TCPSocket

  readonly req: HTTPIncomingMessage | null
  readonly res: HTTPServerResponse | null

  readonly idle: boolean

  static for(socket: TCPSocket): HTTPServerConnection
}

interface HTTPClientRequestEvents extends HTTPOutgoingMessageEvents {
  response: [res: HTTPIncomingMessage]
  upgrade: [res: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
}

interface HTTPClientRequestOptions extends TCPSocketConnectOptions {
  agent?: HTTPAgent | false
  headers?: Record<string, string | number>
  method?: HTTPMethod
  path?: string
}

declare class HTTPClientRequest<
  M extends HTTPClientRequestEvents = HTTPClientRequestEvents
> extends HTTPOutgoingMessage<M> {
  constructor(opts?: HTTPClientRequestOptions, onresponse?: () => void)
  constructor(onresponse: () => void)

  readonly method: HTTPMethod
  readonly path: string
  readonly headers: Record<string, string | number>
}

interface HTTPClientConnectionOptions {
  IncomingMessage?: typeof HTTPIncomingMessage
}

declare class HTTPClientConnection {
  constructor(socket: TCPSocket, opts?: HTTPClientConnectionOptions)

  readonly socket: TCPSocket

  readonly req: HTTPClientRequest | null
  readonly res: HTTPIncomingMessage | null

  readonly idle: boolean

  static for(socket: TCPSocket): HTTPClientConnection | null
  static from(
    socket: TCPSocket,
    opts?: HTTPClientConnectionOptions
  ): HTTPClientConnection
}

declare function createServer(
  opts?: HTTPServerConnectionOptions,
  onrequest?: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void
): HTTPServer

declare function createServer(
  onrequest: (req: HTTPIncomingMessage, res: HTTPServerResponse) => void
): HTTPServer

declare function request(
  url: URL | string,
  opts?: HTTPClientRequestOptions,
  onresponse?: (res: HTTPIncomingMessage) => void
): HTTPClientRequest

declare function request(
  url: URL | string,
  onresponse: (res: HTTPIncomingMessage) => void
): HTTPClientRequest

declare function request(
  opts: HTTPClientRequestOptions,
  onresponse?: (res: HTTPIncomingMessage) => void
): HTTPClientRequest

declare class HTTPError extends Error {
  constructor(msg: string, code: string, fn: Error)

  static NOT_IMPLEMENTED(msg?: string): HTTPError
  static CONNECTION_LOST(msg?: string): HTTPError
}

export {
  HTTPIncomingMessage as IncomingMessage,
  type HTTPIncomingMessageEvents,
  type HTTPIncomingMessageOptions,
  HTTPOutgoingMessage as OutgoingMessage,
  type HTTPOutgoingMessageEvents,
  HTTPAgent as Agent,
  HTTPAgent as globalAgent,
  type HTTPAgentOptions,
  HTTPServer as Server,
  type HTTPServerEvents,
  HTTPServerResponse as ServerResponse,
  HTTPServerConnection as ServerConnection,
  type HTTPServerConnectionOptions,
  HTTPClientRequest as ClientRequest,
  type HTTPClientRequestEvents,
  type HTTPClientRequestOptions,
  HTTPClientConnection as ClientConnection,
  type HTTPClientConnectionOptions,
  createServer,
  request,
  constants,
  type HTTPMethod,
  type HTTPStatusCode,
  type HTTPStatusMessage,
  HTTPError as errors
}
