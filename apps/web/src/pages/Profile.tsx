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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -new Date().getTimezoneOffset();

  useEffect(() => {
    api('/api/me', { token }).then((r) => {
      setDisplayName(r.profile.display_name);
      setSkills((r.profile.skills ?? []).join(', '));
      setLooking(r.profile.looking_for_team);
      setEmail(r.profile.email ?? null);
      setEmailVerified(r.profile.email_verified ?? null);
    }).catch((e) => toast(e.message, 'error')).finally(() => setLoaded(true));
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
    } catch (err: any) {
      // Inputs stay filled; the error is shown inline and as a toast.
      setSaveError(err.message);
      toast(err.message, 'error');
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} className="card mx-auto max-w-2xl space-y-6">
      <div><p className="eyebrow mb-2">Introduce yourself</p><h1 className="text-3xl font-bold">Your profile</h1><p className="mt-2 text-sm text-slate-400">Help the right teammates find you. Add your skills and availability.</p></div>
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
                catch (e: any) {
                  toast(e.code === 'email_not_configured'
                    ? 'Email delivery is not configured on this deployment, so verification emails cannot be sent yet.'
                    : e.message, 'error');
                }
              }}>
              Resend verification email
            </button>
          )}
        </div>
      )}
      {saveError && <p role="alert" className="text-sm text-danger">{saveError}</p>}

      <p className="text-xs text-slate-400">Saving takes you to the board, where you can find a team or start your own.</p>

      <div className="rounded-xl border border-line bg-panel p-3 text-xs text-slate-400 space-y-2">
        <p className="font-semibold text-slate-700">Your data and privacy</p>
        <p>Your display name, skills and timezone are visible to other signed-in participants while you are shown on the board or in suggestions. Suggestions you are shown, and your useful/not-useful votes, are recorded with your account so ranking quality can be measured; only allowlisted organizers can see those records, as aggregate counts. Suggestion impressions older than 30 days are deleted automatically as the app is used.</p>
        <button type="button" className="text-accent hover:underline"
          onClick={async () => {
            try {
              const data = await api('/api/me/export', { token });
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'teamform-my-data.json';
              a.click();
              URL.revokeObjectURL(a.href);
              toast('Your data export downloaded');
            } catch (e: any) { toast(e.message, 'error'); }
          }}>
          Download everything stored about me (JSON)
        </button>
        <p>Account deletion is not self-serve: removing a profile mid-event can trap team seats and leadership. Ask an organizer if you need your account removed.</p>
      </div>

      <button className="btn-primary" disabled={busy || !loaded}>Save</button>
    </form>
  );
}
