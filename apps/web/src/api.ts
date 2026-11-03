// Thin API client. Every mutating call sends a caller-supplied Idempotency-Key
// so double-clicks and retries are safe end-to-end.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

// Same-origin API: deployed behind the web host's /api rewrite (vercel.json),
// proxied by vite dev/preview locally. Same-origin is what lets the refresh
// session live in a first-party HttpOnly cookie instead of JS-readable storage.
const BASE = '';

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
  localStorage.removeItem('tf_sess');
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
      try {
        // The HttpOnly session cookie flows automatically (same-origin). A
        // legacy localStorage refresh token - from before the cookie upgrade -
        // is sent explicitly one last time; the server rotates it, sets the
        // cookie, and we drop the stored copy below.
        const res = await fetch(`${BASE}/api/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(rt ? { refresh_token: rt } : {}),
        });
        if (!res.ok) {
          // Definitive refusal: the cookie session is gone - drop the restore
          // hint so the next boot goes straight to sign-in.
          if (res.status === 401 || res.status === 403) localStorage.removeItem('tf_sess');
          return null;
        }
        const data = await res.json();
        if (data.cookie_set) {
          // Cookie-backed server: never persist the refresh token in
          // JS-readable storage, and remove any legacy stored copy. The
          // non-secret tf_sess flag just marks that a cookie session exists,
          // so the next boot can silently restore it (see auth.tsx).
          localStorage.removeItem('tf_refresh');
          localStorage.setItem('tf_sess', '1');
          storeTokens(data.token, data.user_id);
        } else {
          // Older server without cookie support (rollout window): keep the
          // rotated body token so the session survives.
          storeTokens(data.token, data.user_id, data.refresh_token);
        }
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
      // The session may be cookie-only, so attempt the refresh even when no
      // localStorage refresh token exists.
      if (!retried) {
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
