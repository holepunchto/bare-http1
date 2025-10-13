declare class HTTPError extends Error {
  private constructor()

  static NOT_IMPLEMENTED(msg?: string): HTTPError
  static CONNECTION_LOST(msg?: string): HTTPError
}

export = HTTPError
