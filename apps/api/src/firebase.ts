import { createVerify } from 'node:crypto';
import { errors } from './errors.js';

export interface FirebaseIdentity {
  uid: string;
  email?: string;
  email_verified?: boolean;
}

// Injectable seams for unit tests. Never set in production code paths.
let testVerifier: ((idToken: string) => Promise<FirebaseIdentity>) | null = null;
let testRefresh: ((firebaseRefreshToken: string) => Promise<boolean>) | null = null;

export function setFirebaseTestHooks(
  verifier: ((idToken: string) => Promise<FirebaseIdentity>) | null,
  refresh: ((firebaseRefreshToken: string) => Promise<boolean>) | null = null,
) {
  testVerifier = verifier;
  testRefresh = refresh;
}

const prodLike = () => Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';

// Offline seam for local/E2E runs (unsigned base64url JSON tokens). It is
// hard-refused in any production-like environment - Vercel always sets
// VERCEL=1 - so it cannot be enabled there by accident or by a stray env var.
function testModeAllowed(): boolean {
  return process.env.FIREBASE_TEST_MODE === 'true' && !prodLike();
}

function projectId(): string {
  const pid = process.env.FIREBASE_PROJECT_ID;
  if (!pid) throw errors.unavailable('firebase_not_configured', 'Sign-in is not configured on this deployment');
  return pid;
}

function apiKey(): string {
  const key = process.env.FIREBASE_WEB_API_KEY;
  if (!key) throw errors.unavailable('firebase_not_configured', 'Sign-in is not configured on this deployment');
  return key;
}

// ---------------------------------------------------------------------------
// ID-token verification against Google's public securetoken x509 certs.
// No service-account private key is needed or stored anywhere: signature,
// algorithm, issuer, audience, expiry and subject are all checked locally.
// Any cert-fetch or verification failure is fail-closed.
// ---------------------------------------------------------------------------

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache: { certs: Record<string, string>; expiresAt: number } | null = null;

async function fetchCerts(forceRefresh = false): Promise<Record<string, string>> {
  if (!forceRefresh && certCache && Date.now() < certCache.expiresAt) return certCache.certs;
  let res: Response;
  try {
    res = await fetch(CERTS_URL);
  } catch {
    throw errors.unavailable('firebase_unavailable', 'Sign-in verification is temporarily unavailable');
  }
  if (!res.ok) throw errors.unavailable('firebase_unavailable', 'Sign-in verification is temporarily unavailable');
  const certs = (await res.json()) as Record<string, string>;
  // Honour Google's Cache-Control max-age; fall back to one hour.
  const cc = res.headers.get('cache-control') ?? '';
  const m = /max-age=(\d+)/.exec(cc);
  const maxAgeSec = m ? Math.min(Number(m[1]), 24 * 3600) : 3600;
  certCache = { certs, expiresAt: Date.now() + maxAgeSec * 1000 };
  return certs;
}

function b64urlJson(part: string): any {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw errors.unauthorized();
  }
}

export async function verifyFirebaseIdToken(idToken: string): Promise<FirebaseIdentity> {
  if (testVerifier) return testVerifier(idToken);
  if (process.env.FIREBASE_TEST_MODE === 'true') {
    if (!testModeAllowed()) throw new Error('FIREBASE_TEST_MODE is forbidden in production');
    try {
      return JSON.parse(Buffer.from(idToken, 'base64url').toString('utf8')) as FirebaseIdentity;
    } catch {
      throw errors.unauthorized();
    }
  }
  const pid = projectId();
  const parts = idToken.split('.');
  if (parts.length !== 3) throw errors.unauthorized();
  const [h, p, s] = parts;
  const header = b64urlJson(h);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw errors.unauthorized();

  let certs = await fetchCerts();
  let cert = certs[header.kid];
  if (!cert) {
    certs = await fetchCerts(true); // key rotation: refresh once
    cert = certs[header.kid];
    if (!cert) throw errors.unauthorized();
  }

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  let ok = false;
  try {
    ok = verifier.verify(cert, s, 'base64url');
  } catch {
    ok = false;
  }
  if (!ok) throw errors.unauthorized();

  const claims = b64urlJson(p);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== `https://securetoken.google.com/${pid}`) throw errors.unauthorized();
  if (claims.aud !== pid) throw errors.unauthorized();
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw errors.unauthorized();
  if (typeof claims.iat !== 'number' || claims.iat > now + 60) throw errors.unauthorized();
  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 128) throw errors.unauthorized();
  return { uid: claims.sub, email: claims.email, email_verified: claims.email_verified };
}

// ---------------------------------------------------------------------------
// Revocation enforcement without an Admin SDK: the session family stores the
// user's Firebase refresh token at exchange time. At each app-token rotation
// we redeem it for a fresh Firebase ID token. After a Firebase password
// reset/change (or explicit revocation), Firebase invalidates that refresh
// token, this call fails, and the caller revokes the whole app session
// family. Access tokens still live out their short TTL (documented bound).
// Fail-closed: network/5xx errors also count as "cannot prove validity" and
// the caller treats them per policy (revoke on hard invalid, retry-safe on
// outage - see the caller's error distinction).
// ---------------------------------------------------------------------------

export type FirebaseRefreshCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'unavailable' };

export async function checkFirebaseRefreshToken(firebaseRefreshToken: string): Promise<FirebaseRefreshCheck> {
  if (testRefresh) {
    try {
      return (await testRefresh(firebaseRefreshToken)) ? { ok: true } : { ok: false, reason: 'invalid' };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }
  if (process.env.FIREBASE_TEST_MODE === 'true') {
    if (!testModeAllowed()) throw new Error('FIREBASE_TEST_MODE is forbidden in production');
    return { ok: true };
  }
  let res: Response;
  try {
    res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(firebaseRefreshToken)}`,
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (res.ok) return { ok: true };
  if (res.status >= 500) return { ok: false, reason: 'unavailable' };
  // 4xx: TOKEN_EXPIRED / USER_DISABLED / USER_NOT_FOUND / INVALID_REFRESH_TOKEN
  return { ok: false, reason: 'invalid' };
}
