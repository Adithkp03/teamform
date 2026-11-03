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
  const [invitations, setInvitations] = useState<any[]>([]);
  // Two-step confirm for destructive actions: first tap arms, second executes.
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api(`/api/teams/${id}`, { token }).then(setData).catch((e) => setError(e.message));
    api(`/api/teams/${id}/audit`, { token }).then((r) => setAudit(r.audit)).catch(() => setAudit(null));
    api(`/api/teams/${id}/invitations`, { token }).then((r) => setInvitations(r.invitations)).catch(() => setInvitations([]));
  }, [id, token]);

  async function copyText(text: string, okMsg: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch {
      // Clipboard API can be unavailable (permissions, non-secure context,
      // browser denial): keep the value on screen so it can be copied by hand.
      toast(`Copy failed - the code is shown here, select and copy it manually: ${text}`, 'error');
    }
  }

  // Arms a destructive action on first tap; the second tap within 4s runs it.
  function confirmThen(key: string, action: () => void) {
    if (confirming === key) {
      setConfirming(null);
      action();
    } else {
      setConfirming(key);
      setTimeout(() => setConfirming((c) => (c === key ? null : c)), 4000);
    }
  }

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
  if (!data) return <p className="text-slate-400">Loading team...</p>;

  const { team, members, member_count, is_member, is_leader, pending_requests } = data;
  const full = member_count >= team.team_size_max;
  const expiresIn = team.invite_expires_at ? Math.max(0, Math.round((new Date(team.invite_expires_at).getTime() - Date.now()) / 3600000)) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="card border-t-4 border-t-accent">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><p className="eyebrow mb-2">Team workspace</p><h1 className="page-heading">{team.name}</h1></div>
          <span className="badge" aria-label={`${member_count} of ${team.team_size_max} seats taken`}>
            {member_count}/{team.team_size_max} members{full ? ' - full' : ''}
          </span>
        </div>
        {team.wanted_skills?.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-1">{team.wanted_skills.map((s: string) => <span key={s} className="badge">{s}</span>)}</p>
        )}
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-label="Team status">
          <div><dt className="inline text-slate-400">Seats: </dt><dd className="inline font-medium">{member_count}/{team.team_size_max} taken{team.team_size_max > member_count ? `, ${team.team_size_max - member_count} open` : ''}</dd></div>
          <div><dt className="inline text-slate-400">Range: </dt><dd className="inline font-medium">{team.team_size_min}-{team.team_size_max}</dd></div>
          <div><dt className="inline text-slate-400">Status: </dt><dd className={`inline font-medium ${member_count < team.team_size_min ? 'text-warn' : 'text-emerald-700'}`}>{member_count < team.team_size_min ? `Forming - needs ${team.team_size_min - member_count} more` : full ? 'Full' : 'Ready'}</dd></div>
          <div><dt className="inline text-slate-400">Leader: </dt><dd className="inline font-medium">{members.find((m: any) => m.role === 'leader')?.display_name ?? 'Unknown'}</dd></div>
          {expiresIn !== null && <div><dt className="inline text-slate-400">Invite expires: </dt><dd className="inline font-medium">~{expiresIn}h</dd></div>}
        </dl>
      </div>

      {is_member && (
        <section className="card space-y-3 border-l-4 border-l-accent" aria-label="Invite members">
          <h2 className="font-semibold">Invite members</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
            <li>Share this invite code. They open TeamForm, pick <strong>Join with code</strong> on the board, and enter it.</li>
            <li>Or they find this team on the board and tap <strong>Request to join</strong> - {is_leader ? 'you accept them below' : 'the leader accepts them here'}.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-mono text-lg tracking-[0.3em] text-accent" aria-label={`Invite code ${team.invite_code}`}>{team.invite_code}</p>
            <button className="btn-primary" onClick={() => copyText(team.invite_code, 'Invite code copied')}>Copy code</button>
            <button className="btn-ghost" onClick={() => copyText(`Join my team "${team.name}" on TeamForm: open the app, choose "Join with code" on the board, and enter ${team.invite_code}`, 'Invite message copied - paste it anywhere')}>Copy invite message</button>
            {is_leader && <button className="btn-ghost" onClick={() => act(`/api/teams/${id}/invite/rotate`, 'New code generated - the old one stopped working')}>Rotate code</button>}
          </div>
          <p className="text-xs text-slate-400">Expires in ~{expiresIn}h. Only people you share it with can use it.</p>
        </section>
      )}

      <section aria-label="Members" aria-live="polite">
        <h2 className="mb-2 font-semibold">Members</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {members.map((m: any) => (
            <li key={m.user_id} className="card flex items-center justify-between gap-2">
              <div>
                <p className="font-medium">{m.display_name} {m.role === 'leader' && <span className="badge ml-1">leader</span>}</p>
                <p className="mt-1 flex flex-wrap gap-1">{(m.skills ?? []).map((s: string) => <span key={s} className="badge">{s}</span>)}</p>
              </div>
              {is_leader && m.user_id !== userId && (
                <button
                  className="btn-danger"
                  aria-label={confirming === `remove:${m.user_id}` ? `Confirm removing ${m.display_name} from the team` : `Remove ${m.display_name} from the team`}
                  onClick={() => confirmThen(`remove:${m.user_id}`, () => api(`/api/teams/${id}/members/${m.user_id}`, { method: 'DELETE', token }).then(() => { toast('Member removed'); refresh(); }).catch((e) => toast(e.message, 'error')))}
                >
                  {confirming === `remove:${m.user_id}` ? 'Confirm remove?' : 'Remove'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {is_leader && pending_requests.length > 0 && (
        <section aria-label="Pending join requests" aria-live="polite">
          <h2 className="mb-2 font-semibold">Join requests ({pending_requests.length})</h2>
          <ul className="space-y-2">
            {pending_requests.map((r: any) => (
              <li key={r.id} className="card flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{r.display_name} <span className="text-xs text-slate-400">{r.timezone}</span></p>
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

      {is_member && invitations.length > 0 && (
        <section aria-label="Pending invitations">
          <h2 className="mb-2 font-semibold">Invited, waiting for an answer ({invitations.length})</h2>
          <ul className="space-y-2">
            {invitations.map((inv: any) => (
              <li key={inv.id} className="card flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{inv.display_name} <span className="text-xs text-slate-400">{inv.timezone}</span></p>
                  <p className="text-xs text-slate-400">invited by {inv.invited_by_name}</p>
                </div>
                {(is_leader || inv.invited_by === userId) && (
                  <button className="btn-ghost" onClick={() => api(`/api/invitations/${inv.id}`, { method: 'DELETE', token }).then(() => { toast('Invitation withdrawn'); refresh(); }).catch((e) => toast(e.message, 'error'))}>
                    Withdraw
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {is_member && (
        <button className="btn-danger" onClick={() => confirmThen('leave', () => act(`/api/teams/${id}/leave`, 'You left the team'))}>
          {confirming === 'leave' ? 'Confirm leave?' : 'Leave team'}
        </button>
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
