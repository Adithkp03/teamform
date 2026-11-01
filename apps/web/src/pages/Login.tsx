import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toasts';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [mode, setMode] = useState<'login' | 'signup' | 'dev'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const path = mode === 'dev' ? '/api/auth/dev-login' : `/api/auth/${mode}`;
      const body = mode === 'dev'
        ? { display_name: name || 'Dev User' }
        : mode === 'signup'
          ? { email, password, display_name: name || email.split('@')[0] }
          : { email, password };
      const res = await api(path, { method: 'POST', body });
      login(res.token, res.user_id);
      navigate('/profile');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-2 text-2xl font-bold">Sign in to TeamForm</h1>
      <p className="mb-6 text-sm text-slate-400">Race-proof team formation for hackathons.</p>
      <div className="mb-4 flex gap-2" role="tablist" aria-label="Sign in mode">
        {(['login', 'signup', 'dev'] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
            className={mode === m ? 'btn-primary flex-1' : 'btn-secondary flex-1'}>
            {m === 'login' ? 'Sign in' : m === 'signup' ? 'Create account' : 'Dev login'}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="card space-y-4">
        {mode !== 'login' && (
          <div>
            <label className="label" htmlFor="name">Display name</label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)}
              required={mode === 'dev'} autoFocus={mode === 'dev'} maxLength={80} />
          </div>
        )}
        {mode !== 'dev' && (
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
              {mode === 'signup' && <p className="mt-1 text-xs text-slate-500">At least 8 characters.</p>}
            </div>
          </>
        )}
        <button className="btn-primary w-full" disabled={busy}>
          {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Continue'}
        </button>
        {mode === 'dev' && <p className="text-xs text-slate-500">Dev login is for local/demo use when the server enables it.</p>}
      </form>
    </div>
  );
}
