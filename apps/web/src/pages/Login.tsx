import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toasts';
import {
  firebaseSignIn, firebaseSignUp, firebaseSendReset, firebaseResendVerification, firebaseTokens, firebaseSignOut,
} from '../firebaseClient';

// Dev login tab only for local builds (VITE_SHOW_DEV_LOGIN=true); production never shows it.
const SHOW_DEV_LOGIN = import.meta.env.VITE_SHOW_DEV_LOGIN === 'true';

type Mode = 'login' | 'signup' | 'dev' | 'forgot' | 'claim';

function friendlyFirebaseError(err: any): string {
  switch (err?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Wrong email or password.';
    case 'auth/email-already-in-use':
      return 'That email already has a Firebase account - sign in instead.';
    case 'auth/weak-password':
      return 'Password is too weak - use at least 6 characters.';
    case 'auth/too-many-requests':
      return 'Too many attempts - wait a moment and try again.';
    case 'auth/network-request-failed':
      return 'Network error reaching the sign-in service - check your connection.';
    default:
      return err?.message ?? 'Something went wrong';
  }
}

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [legacyPassword, setLegacyPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // Firebase tokens held while the user completes the legacy-account claim.
  const [pending, setPending] = useState<{ idToken: string; refreshToken: string } | null>(null);
  const [unverifiedUser, setUnverifiedUser] = useState<any>(null);

  async function exchange(idToken: string, refreshToken: string, displayName?: string) {
    const res = await api('/api/auth/firebase', {
      method: 'POST',
      body: { id_token: idToken, firebase_refresh_token: refreshToken, display_name: displayName },
    });
    // Cookie-backed sessions are never written to localStorage; an older
    // server (rollout window) still needs the body token stored.
    login(res.token, res.user_id, res.cookie_set ? undefined : res.refresh_token);
    // The app session is established: drop the Firebase browser credential.
    firebaseSignOut().catch(() => {});
    navigate('/profile');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setUnverifiedUser(null);
    try {
      if (mode === 'forgot') {
        try {
          await firebaseSendReset(email);
        } catch {
          // Deliberately identical outcome: no account enumeration.
        }
        toast('If an account exists for that email, a reset link is on its way (check spam too).');
        setMode('login');
        return;
      }
      if (mode === 'dev') {
        const res = await api('/api/auth/dev-login', { method: 'POST', body: { display_name: name || 'Dev User' } });
        login(res.token, res.user_id, res.cookie_set ? undefined : res.refresh_token);
        navigate('/profile');
        return;
      }
      if (mode === 'claim') {
        if (!pending) throw new Error('Sign in again to restart account migration.');
        const res = await api('/api/auth/firebase/claim', {
          method: 'POST',
          body: {
            id_token: pending.idToken,
            firebase_refresh_token: pending.refreshToken,
            legacy_email: email,
            legacy_password: legacyPassword,
          },
        });
        toast('Your existing CrewForge account and teams are migrated.');
        login(res.token, res.user_id, res.cookie_set ? undefined : res.refresh_token);
        firebaseSignOut().catch(() => {});
        navigate('/profile');
        return;
      }
      if (mode === 'signup') {
        await firebaseSignUp(email, password);
        // Verification arrives by email and sign-in happens fresh afterwards;
        // no reason to keep the Firebase credential in the browser.
        firebaseSignOut().catch(() => {});
        toast('Account created. We sent a verification link to your email (check spam too) - click it, then sign in.');
        setMode('login');
        setPassword('');
        return;
      }
      // login
      const user = await firebaseSignIn(email, password);
      const { idToken, refreshToken } = await firebaseTokens(user);
      if (!user.emailVerified) {
        setUnverifiedUser(user);
        toast('Your email is not verified yet - click the link we sent you, then sign in again.', 'error');
        return;
      }
      try {
        await exchange(idToken, refreshToken, name || undefined);
      } catch (err: any) {
        if (err?.code === 'legacy_claim_required' || String(err?.message ?? '').includes('legacy_claim_required')) {
          // An old password-era CrewForge account holds this email: migrate it
          // by proving legacy ownership. Nothing is inherited automatically.
          setPending({ idToken, refreshToken });
          setMode('claim');
          toast('This email has an existing CrewForge account - enter its old password to migrate it and keep your teams.');
          return;
        }
        throw err;
      }
    } catch (err: any) {
      toast(friendlyFirebaseError(err), 'error');
    } finally { setBusy(false); }
  }

  async function resendVerification() {
    if (!unverifiedUser) return;
    setBusy(true);
    try {
      await firebaseResendVerification(unverifiedUser);
      toast('Verification email resent (check spam too).');
    } catch (err: any) {
      toast(friendlyFirebaseError(err), 'error');
    } finally { setBusy(false); }
  }

  const tabs: Mode[] = SHOW_DEV_LOGIN ? ['login', 'signup', 'dev'] : ['login', 'signup'];

  return (
    <div className="auth-layout">
      <section className="auth-story" aria-label="About CrewForge">
        <div className="flex items-center gap-2.5 text-lg font-bold"><span className="brand-mark" aria-hidden="true">C</span>CrewForge</div>
        <p className="eyebrow mt-10">Build together. Start here.</p>
        <h2 className="mt-4 text-4xl font-bold leading-tight sm:text-5xl">Your next great<br />team starts here.</h2>
        <p className="mt-5 max-w-sm leading-relaxed text-slate-600">Find people with the skills you need. Form a team, share an invite, and get building.</p>
        <div className="auth-illustration" aria-hidden="true"><div className="auth-orbit" /><span className="auth-person left-[8%] top-2 bg-[#d8e7ff] text-[#244783]">&lt;/&gt;</span><span className="auth-person right-[6%] top-6 bg-[#ffecd9] text-[#91542a]">Ux</span><span className="auth-person bottom-0 left-[24%] bg-[#e2e0fb] text-[#5b479c]">AI</span><span className="auth-center">C</span></div>
        <div className="grid gap-3 text-sm text-slate-700"><p><span className="mr-2 text-accent" aria-hidden="true">✓</span>Discover complementary skills</p><p><span className="mr-2 text-accent" aria-hidden="true">✓</span>Leader-approved team requests</p><p><span className="mr-2 text-accent" aria-hidden="true">✓</span>One person. One team. No overbooking.</p></div>
      </section>
      <section className="self-center py-2 lg:px-4">
      <p className="eyebrow mb-3">Your hackathon workspace</p><h1 className="mb-3 text-3xl font-bold">Sign in to CrewForge</h1>
      <p className="mb-6 text-sm text-slate-400">Welcome back. Pick up where your team left off.</p>
      {mode !== 'claim' && mode !== 'forgot' && (
        <div className="mb-4 flex gap-2" role="tablist" aria-label="Sign in mode">
          {tabs.map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
              className={mode === m ? 'btn-primary flex-1' : 'btn-secondary flex-1'}>
              {m === 'login' ? 'Sign in' : m === 'signup' ? 'Create account' : 'Dev login'}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="card space-y-5">
        {mode === 'forgot' && (
          <>
            <p className="text-sm text-slate-400">Enter your account email and we will send a reset link.</p>
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" type="email" className="input" autoComplete="email" value={email}
                onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <button className="btn-primary w-full" disabled={busy}>Send reset link</button>
            <button type="button" className="btn-ghost w-full" onClick={() => setMode('login')}>Back to sign in</button>
          </>
        )}
        {mode === 'claim' && (
          <>
            <p className="text-sm text-slate-300">
              This email belongs to an existing CrewForge account from before we moved sign-in.
              Enter its <strong>old CrewForge password</strong> to migrate it - your teams and roles come along.
              Without it, nothing is transferred.
            </p>
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" type="email" className="input" value={email} readOnly />
            </div>
            <div>
              <label className="label" htmlFor="legacy-password">Old CrewForge password</label>
              <input id="legacy-password" type="password" className="input" autoComplete="current-password"
                value={legacyPassword} onChange={(e) => setLegacyPassword(e.target.value)} required autoFocus />
            </div>
            <button className="btn-primary w-full" disabled={busy}>Migrate my account</button>
            <button type="button" className="btn-ghost w-full" onClick={() => { setMode('login'); setPending(null); }}>
              Back to sign in
            </button>
          </>
        )}
        {(mode === 'signup' || mode === 'dev') && (
          <div>
            <label className="label" htmlFor="name">Display name</label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)}
              required={mode === 'dev'} autoFocus={mode === 'dev'} maxLength={80} />
          </div>
        )}
        {(mode === 'login' || mode === 'signup') && (
          <>
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" type="email" className="input" autoComplete="email" value={email}
                onChange={(e) => setEmail(e.target.value)} required autoFocus={mode === 'login'} />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <input id="password" type="password" className="input" minLength={6}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </>
        )}
        {(mode === 'login' || mode === 'signup' || mode === 'dev') && (
          <button className="btn-primary w-full" disabled={busy}>
            {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Continue'}
          </button>
        )}
        {mode === 'login' && unverifiedUser && (
          <button type="button" className="btn-secondary w-full" disabled={busy} onClick={resendVerification}>
            Resend verification email
          </button>
        )}
        {mode === 'login' && (
          <button type="button" className="w-full text-center text-xs text-accent hover:underline"
            onClick={() => setMode('forgot')}>
            Forgot your password?
          </button>
        )}
        {mode === 'dev' && <p className="text-xs text-slate-400">Dev login is for local/demo use when the server enables it.</p>}
      </form>
      <p className="mt-5 text-xs leading-relaxed text-slate-400">Verification and password-reset emails are sent by Firebase - they can land in spam, so check there too.</p>
      </section>
    </div>
  );
}
