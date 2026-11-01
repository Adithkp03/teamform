// Thin API client. Every mutating call sends a caller-supplied Idempotency-Key
// so double-clicks and retries are safe end-to-end.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const BASE = import.meta.env.VITE_API_URL ?? '';

export async function api<T = any>(
  path: string,
  opts: { method?: string; token?: string | null; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const newIdempotencyKey = () => crypto.randomUUID();
