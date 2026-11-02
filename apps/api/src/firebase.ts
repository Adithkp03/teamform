import { createVerify, createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { errors } from './errors.js';

export interface FirebaseIdentity {
  uid: string;
  email?: string;
  email_verified?: boolean;
}

export type FirebaseRedeemResult =
  | { ok: true; identity: FirebaseIdentity; refreshToken: string }
  | { ok: false; reason: 'invalid' | 'unavailable' };

// Injectable seams for unit tests. Never set in production code paths.
let testVerifier: ((idToken: string) => Promise<FirebaseIdentity>) | null = null;
let testRedeemer: ((refreshToken: string) => Promise<FirebaseRedeemResult>) | null = null;

export function setFirebaseTestHooks(
  verifier: ((idToken: string) => Promise<FirebaseIdentity>) | null,
  redeemer: ((refreshToken: string) => Promise<FirebaseRedeemResult>) | null = null,
) {
  testVerifier = verifier;
  testRedeemer = redeemer;
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
// Firebase refresh-token redemption, used for two things:
//   1. Exchange-time binding: proves the refresh token the client handed us
//      belongs to the SAME Firebase uid as the verified ID token (we never
//      store a bearer credential merely because it is valid for someone).
//   2. Rotation-time revocation: after a Firebase password reset/change,
//      disable, or explicit revocation, redemption fails and the caller
//      revokes the whole app session family.
// The returned id_token is verified with the same strict checks as any
// other. Firebase does not rotate the refresh token on redemption (the web
// SDK reuses one per session), but if the response carries a new one we
// return it so the caller can persist the latest value.
// 'invalid' = Google says the credential is dead (4xx). 'unavailable' =
// network/5xx: the caller applies its bounded outage policy, never an
// unconditional pass.
// ---------------------------------------------------------------------------

export async function redeemFirebaseRefreshToken(refreshToken: string): Promise<FirebaseRedeemResult> {
  if (testRedeemer) return testRedeemer(refreshToken);
  if (process.env.FIREBASE_TEST_MODE === 'true') {
    if (!testModeAllowed()) throw new Error('FIREBASE_TEST_MODE is forbidden in production');
    // Deterministic offline seam: `fb-refresh-<email>` mirrors testIdToken's
    // `test-<email>` uid so tests can exercise binding and mismatch.
    const m = /^fb-refresh-(.+)$/.exec(refreshToken);
    if (!m) return { ok: false, reason: 'invalid' };
    return { ok: true, identity: { uid: `test-${m[1]}`, email: m[1], email_verified: true }, refreshToken };
  }
  let res: Response;
  try {
    res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!res.ok) {
    if (res.status >= 500) return { ok: false, reason: 'unavailable' };
    return { ok: false, reason: 'invalid' }; // TOKEN_EXPIRED / USER_DISABLED / INVALID_REFRESH_TOKEN
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (typeof data?.id_token !== 'string') return { ok: false, reason: 'unavailable' };
  // A 200 with a bad id_token means we cannot prove the credential's state:
  // treat as unavailable (bounded outage policy applies), never as valid.
  let identity: FirebaseIdentity;
  try {
    identity = await verifyFirebaseIdToken(data.id_token);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const next = typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : refreshToken;
  return { ok: true, identity, refreshToken: next };
}

// ---------------------------------------------------------------------------
// At-rest protection for stored Firebase refresh tokens. They are persistent
// bearer credentials, so they are never stored in plaintext: AES-256-GCM
// with a key derived from the deployment's JWT secret (no new secret to
// manage; rotating JWT_SECRET rotates this too, which also invalidates all
// app sessions by design). They are never logged, never returned to clients,
// and nulled when the session family is revoked (see routes/auth.ts).
// ---------------------------------------------------------------------------

function encKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return createHmac('sha256', secret).update('teamform-firebase-refresh-token-store').digest();
}

export function encryptRefreshToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptRefreshToken(stored: string): string {
  const [iv, tag, ct] = stored.split('.');
  if (!iv || !tag || !ct) throw new Error('corrupt stored firebase credential');
  const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
