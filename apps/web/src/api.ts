// Thin API client. Every mutating call sends a caller-supplied Idempotency-Key
// so double-clicks and retries are safe end-to-end.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const BASE = import.meta.env.VITE_API_URL ?? '';

export const getToken = () => localStorage.getItem('tf_token');
export const getRefreshToken = () => localStorage.getItem('tf_refresh');

export function storeTokens(token: string, userId: string, refreshToken?: string) {
  localStorage.setItem('tf_token', token);
  localStorage.setItem('tf_uid', userId);
  if (refreshToken !== undefined) localStorage.setItem('tf_refresh', refreshToken);
  window.dispatchEvent(new Event('tf-auth-changed'));
}

export function clearTokens() {
  localStorage.removeItem('tf_token');
  localStorage.removeItem('tf_uid');
  localStorage.removeItem('tf_refresh');
  window.dispatchEvent(new Event('tf-auth-changed'));
}

// Access tokens are short-lived; a 401 on a non-auth endpoint triggers ONE
// shared refresh and a single retry. Mutations carry idempotency keys, so
// retrying after a refresh replays safely.
let refreshing: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) {
    refreshing = (async () => {
      const rt = getRefreshToken();
      if (!rt) return null;
      try {
        const res = await fetch(`${BASE}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh_token: rt }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        storeTokens(data.token, data.user_id, data.refresh_token);
        return data.token as string;
      } catch {
        return null;
      }
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; token?: string | null; body?: unknown; idempotencyKey?: string } = {},
  retried = false,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      // Only label JSON when there IS a JSON body: Fastify rejects an empty
      // body carrying content-type application/json.
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      // Expired access token: refresh once and retry the original request.
      if (!retried && getRefreshToken()) {
        const nt = await refreshAccessToken();
        if (nt) return api(path, { ...opts, token: nt }, true);
      }
      // No usable session: drop stored credentials and return to sign-in.
      clearTokens();
      window.location.assign('/login');
    }
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const newIdempotencyKey = () => crypto.randomUUID();
