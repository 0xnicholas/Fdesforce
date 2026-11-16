/**
 * Transport for the generated clients. Hand-written on purpose: it carries no
 * wire types, only the HTTP mechanics. Every request/response shape comes from
 * `src/generated/*`, which is produced from `contracts/`.
 */

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Pluggable so tests and the CLI can supply fetch, undici, or a loopback stub. */
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** Today's `fetch`, as a transport. */
export const fetchTransport: Transport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method.toUpperCase(),
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
};

/** A response narrowed by HTTP status: `{ status: 201, body: RunCreateResponse }`. */
export type ApiResult<Responses extends Record<number, unknown>> = {
  [Status in keyof Responses & number]: {
    status: Status;
    body: Responses[Status];
    headers: Record<string, string>;
  };
}[keyof Responses & number];

export interface SendInput {
  method: string;
  baseUrl: string;
  /** OpenAPI path template, e.g. `/v1/runs/{run_id}`. */
  path: string;
  pathParams?: Record<string, string>;
  query?: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

/** Percent-encode path parameters; never let one escape its segment. */
function fillPath(path: string, pathParams: Record<string, string>): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = pathParams[name];
    if (value === undefined) throw new Error(`missing path parameter ${name} for ${path}`);
    return encodeURIComponent(value);
  });
}

function queryString(query: Record<string, unknown> | undefined): string {
  if (query === undefined) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const rendered = search.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

export async function send(transport: Transport, input: SendInput): Promise<unknown> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (value !== undefined) headers[name] = value;
  }
  if (input.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await transport({
    method: input.method,
    url: `${input.baseUrl.replace(/\/+$/, '')}${fillPath(input.path, input.pathParams ?? {})}${queryString(input.query)}`,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });

  const isJson = (response.headers['content-type'] ?? '').includes('json');
  return {
    status: response.status,
    headers: response.headers,
    body: response.body === '' ? undefined : isJson ? (JSON.parse(response.body) as unknown) : response.body,
  };
}
