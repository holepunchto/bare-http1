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

export const METHODS: HTTPMethod[]
export const STATUS_CODES: typeof constants.status

export interface HTTPIncomingMessageEvents extends ReadableEvents {
  timeout: []
}

export interface HTTPIncomingMessageOptions {
  headers?: Record<string, string | number>
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
  headers: Record<string, string | number>
  method: HTTPMethod
  url: string
  statusCode: HTTPStatusCode
  statusMessage: HTTPStatusMessage
  readonly httpVersion: '1.1'

  getHeader(name: string): string | number | undefined
  getHeaders(): Record<string, string | number>
  hasHeader(name: string): boolean

  setTimeout(ms: number, ontimeout?: () => void): this
}

declare class HTTPIncomingMessage<
  M extends HTTPIncomingMessageEvents = HTTPIncomingMessageEvents
> extends Readable<M> {
  constructor(socket?: TCPSocket, opts?: HTTPIncomingMessageOptions)
}

export { type HTTPIncomingMessage, HTTPIncomingMessage as IncomingMessage }

export interface HTTPOutgoingMessageEvents extends WritableEvents {
  timeout: []
}

interface HTTPOutgoingMessage<
  M extends HTTPOutgoingMessageEvents = HTTPOutgoingMessageEvents
> extends Writable<M> {
  readonly socket: TCPSocket
  readonly upgrade: boolean
  readonly headersSent: boolean
  headers: Record<string, string | number>

  getHeader(name: string): string | number | undefined
  getHeaders(): Record<string, string | number>
  hasHeader(name: string): boolean
  setHeader(name: string, value: string | number): void
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
  keepAlive?: boolean
  keepAliveMsecs?: number
}

interface HTTPAgent {
  readonly suspended: boolean
  readonly resumed: Promise<void> | null
  readonly sockets: IterableIterator<TCPSocket>
  readonly freeSockets: IterableIterator<TCPSocket>

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
  upgrade: [req: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
  timeout: [socket: TCPSocket]
}

interface HTTPServer<M extends HTTPServerEvents = HTTPServerEvents> extends TCPServer<M> {
  readonly timeout: number | undefined

  setTimeout(ms: number, ontimeout?: () => void): this
}

declare class HTTPServer<M extends HTTPServerEvents = HTTPServerEvents> extends TCPServer<M> {
  constructor(
    opts?: HTTPServerConnectionOptions,
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
    headers?: Record<string, string | number>
  ): void

  writeHead(statusCode: HTTPStatusCode, headers?: Record<string, string | number>): void
}

declare class HTTPServerResponse extends HTTPOutgoingMessage {
  constructor(socket: TCPSocket, req: HTTPIncomingMessage)
}

export { type HTTPServerResponse, HTTPServerResponse as ServerResponse }

export interface HTTPServerConnectionOptions {
  IncomingMessage?: typeof HTTPIncomingMessage
  ServerResponse?: typeof HTTPServerResponse
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
  upgrade: [res: HTTPIncomingMessage, socket: TCPSocket, head: Buffer]
}

export interface HTTPClientRequestOptions extends TCPSocketConnectOptions {
  agent?: HTTPAgent | false
  headers?: Record<string, string | number>
  method?: HTTPMethod
  path?: string
}

interface HTTPClientRequest<
  M extends HTTPClientRequestEvents = HTTPClientRequestEvents
> extends HTTPOutgoingMessage<M> {
  readonly method: HTTPMethod
  readonly path: string
  readonly headers: Record<string, string | number>
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
  opts?: HTTPServerConnectionOptions,
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
