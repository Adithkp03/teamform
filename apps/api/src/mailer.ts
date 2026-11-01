/**
 * Outbound auth email (verification + password reset).
 *
 * Provider 'log' (the default and only wired provider) records the message in
 * the process log and an in-memory outbox for tests and local dev. Nothing
 * leaves the process: sending real email is external communication on the
 * user's behalf and needs a user-approved sending identity (provider account,
 * verified sender/domain). That integration is deliberately not stubbed into
 * production; the endpoints, tokens and UI work end to end regardless, and
 * the log provider shows exactly what would be sent.
 */
export interface OutboundMail {
  to: string;
  kind: 'verify' | 'reset';
  url: string;
  at: number;
}

// 'log' is a DEV/TEST provider: it keeps the full message (incl. the token
// URL) in-process only. On Vercel/production without an explicit provider it
// resolves to 'none': mail is dropped and - critically - no reset/verify
// token is ever written to production logs. Real delivery needs a
// user-approved sending identity; wiring it is a deliberate one-line change
// here plus a provider module.
const PROVIDER = process.env.MAIL_PROVIDER
  ?? (process.env.VERCEL || process.env.NODE_ENV === 'production' ? 'none' : 'log');

const outbox: OutboundMail[] = [];
const MAX_OUTBOX = 64;

/** Test/local introspection: the most recent mails, newest last. */
export function mailOutbox(): OutboundMail[] {
  return outbox;
}

export async function sendAuthMail(to: string, kind: 'verify' | 'reset', url: string): Promise<void> {
  if (PROVIDER === 'none') {
    // Never log the URL: it carries a bearer-equivalent token.
    console.log(`[mailer:none] ${kind} mail for ${to} dropped - no mail provider configured`);
    return;
  }
  if (outbox.length >= MAX_OUTBOX) outbox.shift();
  outbox.push({ to, kind, url, at: Date.now() });
  console.log(`[mailer:log] ${kind} -> ${to} (full URL in dev outbox only)`);
}

export function authMailUrl(kind: 'verify' | 'reset', token: string): string {
  const origin = process.env.APP_ORIGIN ?? 'http://localhost:5173';
  const path = kind === 'verify' ? '/verify' : '/reset';
  return `${origin}${path}?token=${token}`;
}
