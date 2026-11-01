import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createClient } from '@supabase/supabase-js';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toasts';

const SUPA_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPA_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const useSupabase = Boolean(SUPA_URL && SUPA_ANON);

  async function devLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api('/api/auth/dev-login', { method: 'POST', body: { display_name: name || 'Dev User' } });
      login(res.token, res.user_id);
      navigate('/profile');
    } catch (err: any) {
      toast(err.message, 'error');
    } finally { setBusy(false); }
  }

  async function sendOtp(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const supabase = createClient(SUPA_URL!, SUPA_ANON!);
      const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      if (error) throw error;
      setOtpSent(true);
      toast('Code sent - check your email');
    } catch (err: any) { toast(err.message, 'error'); } finally { setBusy(false); }
  }

  async function verifyOtp(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const supabase = createClient(SUPA_URL!, SUPA_ANON!);
      const { data, error } = await supabase.auth.verifyOtp({ email, token: otp, type: 'email' });
      if (error) throw error;
      const session = data.session!;
      login(session.access_token, session.user.id);
      navigate('/profile');
    } catch (err: any) { toast(err.message, 'error'); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-2 text-2xl font-bold">Sign in to TeamForm</h1>
      <p className="mb-6 text-sm text-slate-400">Race-proof team formation for hackathons.</p>
      {useSupabase ? (
        otpSent ? (
          <form onSubmit={verifyOtp} className="card space-y-4">
            <div>
              <label className="label" htmlFor="otp">Email code</label>
              <input id="otp" className="input" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} required />
            </div>
            <button className="btn-primary w-full" disabled={busy}>Verify</button>
          </form>
        ) : (
          <form onSubmit={sendOtp} className="card space-y-4">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <button className="btn-primary w-full" disabled={busy}>Email me a sign-in code</button>
          </form>
        )
      ) : (
        <form onSubmit={devLogin} className="card space-y-4">
          <div>
            <label className="label" htmlFor="name">Display name</label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <button className="btn-primary w-full" disabled={busy}>Continue</button>
          <p className="text-xs text-slate-500">Dev login - configure Supabase for email sign-in.</p>
        </form>
      )}
    </div>
  );
}
