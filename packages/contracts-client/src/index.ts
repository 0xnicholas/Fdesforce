import { ContextServiceClient, RuntimeApiClient } from './generated/index.js';
import { fetchTransport, type Transport } from './transport.js';

export * from './generated/index.js';
export { fetchTransport, send } from './transport.js';
export type { ApiResult, HttpRequest, HttpResponse, SendInput, Transport } from './transport.js';

export interface ClientOptions {
  /** e.g. `https://fde.example.internal` or `http://context-service:8011`. */
  baseUrl: string;
  /** Defaults to `fetchTransport`. */
  transport?: Transport;
  /** Static headers (auth, trace defaults). Per-call headers win. */
  headers?: Record<string, string>;
}

/** Client for the client-facing Run API exposed by the generated runtime app. */
export function createRuntimeApiClient(options: ClientOptions): RuntimeApiClient {
  return new RuntimeApiClient(options.transport ?? fetchTransport, options.baseUrl, options.headers);
}

/** Client for the internal API owned by context-service. */
export function createContextServiceClient(options: ClientOptions): ContextServiceClient {
  return new ContextServiceClient(options.transport ?? fetchTransport, options.baseUrl, options.headers);
}
