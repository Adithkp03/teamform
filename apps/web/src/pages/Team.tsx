import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, newIdempotencyKey } from '../api';
import { useAuth } from '../auth';
import { subscribeBoardChanges } from '../realtime';
import { useToast } from '../components/Toasts';

export default function Team() {
  const { id } = useParams();
  const { token, userId } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<any>(null);
  const [audit, setAudit] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api(`/api/teams/${id}`, { token }).then(setData).catch((e) => setError(e.message));
    api(`/api/teams/${id}/audit`, { token }).then((r) => setAudit(r.audit)).catch(() => setAudit(null));
  }, [id, token]);

  useEffect(() => {
    refresh();
    return subscribeBoardChanges(refresh, token);
  }, [refresh, token]);

  async function act(path: string, label: string) {
    try {
      await api(path, { method: 'POST', token, idempotencyKey: newIdempotencyKey() });
      toast(label);
      refresh();
    } catch (e: any) { toast(e.message, 'error'); }
  }

  if (error) return <p role="alert" className="text-danger">{error}</p>;
  if (!data) return <p className="text-slate-500">Loading team...</p>;

  const { team, members, member_count, is_member, is_leader, pending_requests } = data;
  const full = member_count >= team.team_size_max;
  const expiresIn = team.invite_expires_at ? Math.max(0, Math.round((new Date(team.invite_expires_at).getTime() - Date.now()) / 3600000)) : null;

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">{team.name}</h1>
          <span className="badge" aria-label={`${member_count} of ${team.team_size_max} seats taken`}>
            {member_count}/{team.team_size_max} members{full ? ' - full' : ''}
          </span>
        </div>
        {team.wanted_skills?.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-1">{team.wanted_skills.map((s: string) => <span key={s} className="badge">{s}</span>)}</p>
        )}
        {member_count < team.team_size_min && (
          <p className="mt-2 text-xs text-warn">Forming: needs at least {team.team_size_min} members.</p>
        )}
      </div>

      {is_member && (
        <div className="card space-y-2" aria-label="Invite code">
          <h2 className="font-semibold">Invite code</h2>
          <p className="font-mono text-lg tracking-[0.3em] text-accent">{team.invite_code}</p>
          <p className="text-xs text-slate-500">Expires in ~{expiresIn}h. Share it with people you trust.</p>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => { navigator.clipboard.writeText(team.invite_code); toast('Copied'); }}>Copy</button>
            {is_leader && <button className="btn-ghost" onClick={() => act(`/api/teams/${id}/invite/rotate`, 'New code generated')}>Rotate code</button>}
          </div>
        </div>
      )}

      <section aria-label="Members">
        <h2 className="mb-2 font-semibold">Members</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {members.map((m: any) => (
            <li key={m.user_id} className="card flex items-center justify-between gap-2">
              <div>
                <p className="font-medium">{m.display_name} {m.role === 'leader' && <span className="badge ml-1">leader</span>}</p>
                <p className="mt-1 flex flex-wrap gap-1">{(m.skills ?? []).map((s: string) => <span key={s} className="badge">{s}</span>)}</p>
              </div>
              {is_leader && m.user_id !== userId && (
                <button className="btn-danger" onClick={() => api(`/api/teams/${id}/members/${m.user_id}`, { method: 'DELETE', token }).then(() => { toast('Member removed'); refresh(); }).catch((e) => toast(e.message, 'error'))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {is_leader && pending_requests.length > 0 && (
        <section aria-label="Pending join requests">
          <h2 className="mb-2 font-semibold">Join requests ({pending_requests.length})</h2>
          <ul className="space-y-2">
            {pending_requests.map((r: any) => (
              <li key={r.id} className="card flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{r.display_name} <span className="text-xs text-slate-500">{r.timezone}</span></p>
                  {r.message && <p className="text-sm text-slate-400">"{r.message}"</p>}
                  <p className="mt-1 flex flex-wrap gap-1">{(r.skills ?? []).map((s: string) => <span key={s} className="badge">{s}</span>)}</p>
                </div>
                <div className="flex gap-2">
                  <button className="btn-primary" disabled={full} onClick={() => act(`/api/requests/${r.id}/accept`, 'Request accepted')}>Accept</button>
                  <button className="btn-danger" onClick={() => act(`/api/requests/${r.id}/decline`, 'Request declined')}>Decline</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {is_member && (
        <button className="btn-danger" onClick={() => act(`/api/teams/${id}/leave`, 'You left the team')}>Leave team</button>
      )}

      {audit && (
        <section aria-label="Audit log">
          <h2 className="mb-2 font-semibold">History</h2>
          <ol className="space-y-1 text-sm text-slate-400">
            {audit.map((a: any) => (
              <li key={a.id}>
                <time dateTime={a.created_at}>{new Date(a.created_at).toLocaleString()}</time>
                {' - '}
                {a.subject_name && a.subject_name !== a.actor_name
                  ? `${a.subject_name}: ${a.action.replaceAll('_', ' ')} (by ${a.actor_name ?? 'system'})`
                  : `${a.actor_name ?? 'system'}: ${a.action.replaceAll('_', ' ')}`}
              </li>
            ))}
          </ol>
        </section>
      )}

      <p><Link to="/board" className="text-accent hover:underline">&larr; Back to board</Link></p>
    </div>
  );
}
