import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toasts';
import { FIREBASE_TEST_MODE, authErrorMessage, resendVerification, sendReset, signIn, signUp } from '../firebaseClient';

// Dev login tab only for local builds (VITE_SHOW_DEV_LOGIN=true); production never shows it.
const SHOW_DEV_LOGIN = import.meta.env.VITE_SHOW_DEV_LOGIN === 'true';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState<'login' | 'signup' | 'dev' | 'forgot' | 'check-email'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function exchange(idToken: string, displayName?: string) {
    const res = await api('/api/auth/firebase', {
      method: 'POST',
      body: { id_token: idToken, ...(displayName ? { display_name: displayName } : {}) },
    });
    login(res.token, res.user_id, res.refresh_token);
    navigate('/profile');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === 'forgot') {
        try {
          await sendReset(email);
          toast('If an account exists for that email, a reset link is on its way.');
          setMode('login');
        } catch (err: any) {
          toast(authErrorMessage(err), 'error');
        }
        return;
      }
      if (mode === 'dev') {
        const res = await api('/api/auth/dev-login', { method: 'POST', body: { display_name: name || 'Dev User' } });
        login(res.token, res.user_id, res.refresh_token);
        navigate('/profile');
        return;
      }
      if (mode === 'signup') {
        if (FIREBASE_TEST_MODE) {
          await exchange(await signIn(email, password), name || email.split('@')[0]);
          return;
        }
        await signUp(email, password);
        setMode('check-email');
        return;
      }
      // mode === 'login'
      try {
        await exchange(await signIn(email, password));
      } catch (err: any) {
        if (err?.code === 'forbidden' || String(err?.message ?? '').includes('email_unverified')) {
          toast('Your email is not verified yet. Check your inbox, or resend the verification email.', 'error');
          return;
        }
        throw err;
      }
    } catch (err: any) {
      toast(authErrorMessage(err), 'error');
    } finally { setBusy(false); }
  }

  async function resend() {
    setBusy(true);
    try {
      await resendVerification(email, password);
      toast('Verification email sent again. Check your inbox and spam folder.');
    } catch (err: any) {
      toast(authErrorMessage(err), 'error');
    } finally { setBusy(false); }
  }

  return (
    <div className="auth-layout">
      <section className="auth-story" aria-label="About TeamForm">
        <div className="flex items-center gap-2.5 text-lg font-bold"><span className="brand-mark" aria-hidden="true">T</span>TeamForm</div>
        <p className="eyebrow mt-10">Build together. Start here.</p>
        <h2 className="mt-4 text-4xl font-bold leading-tight sm:text-5xl">Your next great<br />team starts here.</h2>
        <p className="mt-5 max-w-sm leading-relaxed text-slate-600">Find people with the skills you need. Form a team, share an invite, and get building.</p>
        <div className="auth-illustration" aria-hidden="true"><div className="auth-orbit" /><span className="auth-person left-[8%] top-2 bg-[#d8e7ff] text-[#244783]">&lt;/&gt;</span><span className="auth-person right-[6%] top-6 bg-[#ffecd9] text-[#91542a]">Ux</span><span className="auth-person bottom-0 left-[24%] bg-[#e2e0fb] text-[#5b479c]">AI</span><span className="auth-center">T</span></div>
        <div className="grid gap-3 text-sm text-slate-700"><p><span className="mr-2 text-accent" aria-hidden="true">✓</span>Discover complementary skills</p><p><span className="mr-2 text-accent" aria-hidden="true">✓</span>Leader-approved team requests</p><p><span className="mr-2 text-accent" aria-hidden="true">✓</span>One person. One team. No overbooking.</p></div>
      </section>
      <section className="self-center py-2 lg:px-4">
      <p className="eyebrow mb-3">Your hackathon workspace</p><h1 className="mb-3 text-3xl font-bold">Sign in to TeamForm</h1>
      <p className="mb-6 text-sm text-slate-400">Welcome back. Pick up where your team left off.</p>
      {mode === 'check-email' ? (
        <div className="card space-y-4" role="status">
          <h2 className="text-lg font-semibold text-slate-900">Verify your email</h2>
          <p className="text-sm text-slate-600">We sent a verification link to <span className="font-medium">{email}</span>. Open it, then come back and sign in. Check the spam folder if you do not see it.</p>
          <button className="btn-primary w-full" onClick={() => setMode('login')}>Back to sign in</button>
          <button type="button" className="btn-ghost w-full" disabled={busy} onClick={async () => { try { await resend(); } catch { /* password not retained: ask to sign in */ } }}>
            Resend verification email
          </button>
        </div>
      ) : (
      <>
      <div className="mb-4 flex gap-2" role="tablist" aria-label="Sign in mode">
        {((SHOW_DEV_LOGIN ? ['login', 'signup', 'dev'] : ['login', 'signup']) as Array<'login' | 'signup' | 'dev'>).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
            className={mode === m ? 'btn-primary flex-1' : 'btn-secondary flex-1'}>
            {m === 'login' ? 'Sign in' : m === 'signup' ? 'Create account' : 'Dev login'}
          </button>
        ))}
      </div>
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
        {mode !== 'login' && mode !== 'forgot' && (
          <div>
            <label className="label" htmlFor="name">Display name</label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)}
              required={mode === 'dev'} autoFocus={mode === 'dev'} maxLength={80} />
          </div>
        )}
        {mode !== 'dev' && mode !== 'forgot' && (
          <>
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" type="email" className="input" autoComplete="email" value={email}
                onChange={(e) => setEmail(e.target.value)} required autoFocus={mode === 'login'} />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <input id="password" type="password" className="input" minLength={8}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                value={password} onChange={(e) => setPassword(e.target.value)} required />
              {mode === 'signup' && <p className="mt-1 text-xs text-slate-400">At least 8 characters.</p>}
            </div>
          </>
        )}
        {mode !== 'forgot' && (
          <button className="btn-primary w-full" disabled={busy}>
            {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Continue'}
          </button>
        )}
        {mode === 'login' && (
          <>
            <button type="button" className="w-full text-center text-xs text-accent hover:underline"
              onClick={() => setMode('forgot')}>
              Forgot your password?
            </button>
            <button type="button" className="w-full text-center text-xs text-slate-400 hover:underline" disabled={busy}
              onClick={resend}>
              Resend verification email
            </button>
          </>
        )}
        {mode === 'dev' && <p className="text-xs text-slate-400">Dev login is for local/demo use when the server enables it.</p>}
      </form>
      <p className="mt-5 text-xs leading-relaxed text-slate-400">Sign-in is secured by Firebase Authentication. Verification and password-reset emails are delivered by Firebase; they can land in spam.</p>
      </>
      )}
      </section>
    </div>
  );
}
