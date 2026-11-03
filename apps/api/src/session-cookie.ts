import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors } from './errors.js';
import { prodLike } from './firebase.js';

// Refresh-token session cookie: the browser's only long-lived app credential
// moves out of JS-readable storage into an HttpOnly cookie scoped to the
// auth routes. The token itself is unchanged - an opaque 30-day secret whose
// SHA-256 hash is stored, with the existing family rotation, reuse detection
// and revocation. SameSite=Lax is the primary CSRF control (cross-site POSTs
// never carry the cookie); assertCookieOrigin adds an explicit Origin
// allowlist on cookie-authenticated calls as defense-in-depth.
export const REFRESH_COOKIE = 'tf_rt';
const MAX_AGE_SEC = 30 * 24 * 3600; // mirrors the refresh-token expiry

const attrs = () => `Path=/api/auth; HttpOnly; SameSite=Lax${prodLike() ? '; Secure' : ''}`;

export function parseRefreshCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
    const v = part.slice(eq + 1).trim();
    // Opaque hex token; anything else is ignored, never echoed onward.
    return /^[0-9a-f]{64}$/.test(v) ? v : null;
  }
  return null;
}

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.header('set-cookie', `${REFRESH_COOKIE}=${token}; ${attrs()}; Max-Age=${MAX_AGE_SEC}`);
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${REFRESH_COOKIE}=; ${attrs()}; Max-Age=0`);
}

const allowedOrigins = () => {
  const configured = (process.env.CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // Same fail-closed policy as the CORS setup in app.ts: production-like
  // deployments must configure CORS_ORIGIN (buildApp refuses to boot
  // otherwise); local/dev defaults cover vite dev and the e2e preview port.
  return configured.length
    ? configured
    : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3101', 'http://127.0.0.1:3101'];
};

/** CSRF check for every session-issuing and cookie-authenticated route: a
 *  browser-supplied Origin must be an explicitly allowed web origin. Applied
 *  to ALL of them (not just refresh/logout) so a cross-site POST cannot plant
 *  an attacker-controlled session cookie (login CSRF) - including via a
 *  known body token under an ambient cookie. Requests without an Origin
 *  header (curl, server-to-server, the e2e/API test seams) are unaffected;
 *  SameSite=Lax remains the primary control on the cookie itself. */
export function assertCookieOrigin(req: FastifyRequest): void {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!allowedOrigins().includes(origin)) throw errors.forbidden('Origin not allowed');
}
