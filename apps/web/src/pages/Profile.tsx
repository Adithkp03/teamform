import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toasts';

export default function Profile() {
  const { token } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState<string | null>(null);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [skills, setSkills] = useState('');
  const [looking, setLooking] = useState(true);
  const [busy, setBusy] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -new Date().getTimezoneOffset();

  useEffect(() => {
    api('/api/me', { token }).then((r) => {
      setDisplayName(r.profile.display_name);
      setSkills((r.profile.skills ?? []).join(', '));
      setLooking(r.profile.looking_for_team);
      setEmail(r.profile.email ?? null);
      setEmailVerified(r.profile.email_verified ?? null);
    }).catch(() => {});
  }, [token]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/me', {
        method: 'PUT', token,
        body: {
          display_name: displayName,
          skills: skills.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
          timezone: tz, utc_offset_minutes: offset, looking_for_team: looking,
        },
      });
      toast('Profile saved');
      navigate('/board');
    } catch (err: any) { toast(err.message, 'error'); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} className="card mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-bold">Your profile</h1>
      <div>
        <label className="label" htmlFor="dn">Display name</label>
        <input id="dn" className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
      </div>
      <div>
        <label className="label" htmlFor="sk">Skills (comma separated)</label>
        <input id="sk" className="input" placeholder="react, node, postgres" value={skills} onChange={(e) => setSkills(e.target.value)} />
      </div>
      <p className="text-xs text-slate-400">Timezone: {tz} (used for teammate matching)</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={looking} onChange={(e) => setLooking(e.target.checked)} />
        Show me on the "looking for teammates" board
      </label>
      {email && (
        <div className="rounded border border-line bg-panel px-3 py-2 text-sm">
          <p>Email: <span className="font-mono">{email}</span>{' '}
            {emailVerified
              ? <span className="badge">verified</span>
              : <span className="badge">not verified</span>}
          </p>
          {!emailVerified && (
            <button type="button" className="mt-2 text-xs text-accent hover:underline"
              onClick={async () => {
                try { await api('/api/auth/resend-verification', { method: 'POST', token, body: {} }); toast('Verification email sent'); }
                catch (e: any) { toast(e.message, 'error'); }
              }}>
              Resend verification email
            </button>
          )}
        </div>
      )}
      <button className="btn-primary" disabled={busy}>Save</button>
    </form>
  );
}
