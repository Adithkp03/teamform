import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useToast } from '../components/Toasts';

export default function Reset() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) { toast('Passwords do not match', 'error'); return; }
    setBusy(true);
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: { token: token.trim(), password } });
      toast('Password updated. Sign in with the new password.');
      navigate('/login');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-2 text-2xl font-bold">Reset your password</h1>
      <p className="mb-6 text-sm text-slate-400">Paste the reset token from your email and choose a new password.</p>
      <form onSubmit={submit} className="card space-y-4">
        <div>
          <label className="label" htmlFor="rtok">Reset token</label>
          <input id="rtok" className="input font-mono" value={token} onChange={(e) => setToken(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="rpw">New password</label>
          <input id="rpw" type="password" className="input" minLength={8} autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="rpw2">Confirm new password</label>
          <input id="rpw2" type="password" className="input" minLength={8} autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        <button className="btn-primary w-full" disabled={busy}>Set new password</button>
        <p className="text-center text-xs"><Link to="/login" className="text-accent hover:underline">Back to sign in</Link></p>
      </form>
    </div>
  );
}
