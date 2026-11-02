import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useToast } from '../components/Toasts';

export default function Verify() {
  const [params] = useSearchParams();
  const toast = useToast();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/auth/verify-email', { method: 'POST', body: { token: token.trim() } });
      setDone(true);
    } catch (err: any) {
      toast(err.message, 'error');
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-2 text-2xl font-bold">Verify your email</h1>
      {done ? (
        <div className="card space-y-3">
          <p className="text-sm">Email verified. Thanks!</p>
          <Link to="/board" className="btn-primary inline-block">Go to the board</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="card space-y-4">
          <p className="text-sm text-slate-400">Paste the verification token from your email.</p>
          <div>
            <label className="label" htmlFor="vtok">Verification token</label>
            <input id="vtok" className="input font-mono" value={token} onChange={(e) => setToken(e.target.value)} required />
          </div>
          <button className="btn-primary w-full" disabled={busy}>Verify email</button>
          <p className="text-center text-xs"><Link to="/login" className="text-accent hover:underline">Back to sign in</Link></p>
        </form>
      )}
    </div>
  );
}
