import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toasts';

/**
 * Organizer console. Visible only to allowlisted organizers
 * (ORGANIZER_EMAILS + a verified email on the profile; the API is the real
 * gate - this page is discoverability, not a security boundary).
 */
export default function Organizer() {
  const { token } = useAuth();
  const toast = useToast();
  const [state, setState] = useState<'loading' | 'denied' | 'ok'>('loading');
  const [overview, setOverview] = useState<any>(null);
  const [stuck, setStuck] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[] | null>(null);
  const [matching, setMatching] = useState<any>(null);
  const [auditFilter, setAuditFilter] = useState({ action: '', user_id: '', team_id: '' });
  const [settings, setSettings] = useState({ name: '', team_size_min: '', team_size_max: '', invite_code_ttl_minutes: '' });

  const load = useCallback(async () => {
    try {
      const [ov, st, ma] = await Promise.all([
        api('/api/organizer/overview', { token }),
        api('/api/organizer/requests/stuck', { token }),
        api('/api/organizer/matching', { token }),
      ]);
      setOverview(ov);
      setStuck(st.stuck);
      setMatching(ma);
      setSettings({
        name: ov.event.name,
        team_size_min: String(ov.event.team_size_min),
        team_size_max: String(ov.event.team_size_max),
        invite_code_ttl_minutes: String(ov.event.invite_code_ttl_minutes),
      });
      setState('ok');
    } catch (e: any) {
      if (e?.status === 403 || e?.status === 401) setState('denied');
      else toast(e.message, 'error');
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api('/api/organizer/event', {
        method: 'PUT', token,
        body: {
          name: settings.name,
          team_size_min: Number(settings.team_size_min),
          team_size_max: Number(settings.team_size_max),
          invite_code_ttl_minutes: Number(settings.invite_code_ttl_minutes),
        },
      });
      toast(res.teams_over_max > 0
        ? `Saved. Note: ${res.teams_over_max} existing team(s) now exceed the max size.`
        : 'Event settings saved.');
      load();
    } catch (err: any) { toast(err.message, 'error'); }
  }

  async function searchAudit(e?: FormEvent) {
    e?.preventDefault();
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(auditFilter)) if (v.trim()) params.set(k, v.trim());
    try {
      const res = await api(`/api/organizer/audit?${params}`, { token });
      setAudit(res.audit);
    } catch (err: any) { toast(err.message, 'error'); }
  }

  function exportCsv() {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(auditFilter)) if (v.trim()) params.set(k, v.trim());
    // CSV export is a plain GET; open with the bearer token via fetch->blob so
    // the Authorization header never lands in a URL.
    api(`/api/organizer/audit/export?${params}`, { token }).then(() => {}).catch(() => {});
    fetch(`${(import.meta.env.VITE_API_URL as string | undefined) ?? ''}/api/organizer/audit/export?${params}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.blob()).then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `teamform-audit-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }).catch((err) => toast(err.message, 'error'));
  }

  async function resolveStuck(id: string) {
    const reason = window.prompt('Reason for cancelling this request (shown in the audit log):');
    if (!reason?.trim()) return;
    try {
      await api(`/api/organizer/requests/${id}/resolve`, { method: 'POST', token, body: { reason: reason.trim() } });
      toast('Request cancelled and audited.');
      load();
    } catch (err: any) { toast(err.message, 'error'); }
  }

  if (state === 'loading') return <p className="text-slate-400">Loading organizer console...</p>;
  if (state === 'denied') return (
    <div className="space-y-2">
      <h1 className="page-heading">Organizer console</h1>
      <p className="text-slate-400">This account is not an organizer on this deployment. Organizers are an explicit allowlist of verified email addresses set by the operator.</p>
    </div>
  );

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow mb-3">Operations</p>
        <h1 className="page-heading">Organizer console</h1>
        <p className="mt-3 text-slate-400">Event setup, participant support and audit for {overview.event.name}.</p>
      </header>

      <section aria-label="Event overview" className="grid gap-3 sm:grid-cols-4">
        {[
          ['Participants', overview.participants],
          ['Teams', overview.teams],
          ['Pending requests', overview.pending_requests],
          ['Stuck >24h', overview.stuck_requests_24h],
        ].map(([label, value]) => (
          <div key={label as string} className="card"><p className="text-xs text-slate-400">{label}</p><p className="text-2xl font-bold">{value as any}</p></div>
        ))}
      </section>

      <section aria-label="Event settings" className="card space-y-3">
        <h2 className="text-lg font-semibold">Event settings</h2>
        <form onSubmit={saveSettings} className="grid gap-3 sm:grid-cols-4">
          <label className="text-sm text-slate-700 sm:col-span-2">Event name
            <input className="input mt-1" value={settings.name} onChange={(e) => setSettings({ ...settings, name: e.target.value })} required />
          </label>
          <label className="text-sm text-slate-700">Min team size
            <input className="input mt-1" type="number" min={1} max={20} value={settings.team_size_min} onChange={(e) => setSettings({ ...settings, team_size_min: e.target.value })} required />
          </label>
          <label className="text-sm text-slate-700">Max team size
            <input className="input mt-1" type="number" min={1} max={50} value={settings.team_size_max} onChange={(e) => setSettings({ ...settings, team_size_max: e.target.value })} required />
          </label>
          <label className="text-sm text-slate-700 sm:col-span-2">Invite code TTL (minutes)
            <input className="input mt-1" type="number" min={10} max={43200} value={settings.invite_code_ttl_minutes} onChange={(e) => setSettings({ ...settings, invite_code_ttl_minutes: e.target.value })} required />
          </label>
          <div className="flex items-end sm:col-span-2"><button className="btn-primary" type="submit">Save settings</button></div>
        </form>
        <p className="text-xs text-slate-400">Every change is written to the audit log with before/after values. Lowering the max size never shrinks existing teams; you will be told how many exceed it.</p>
      </section>

      <section aria-label="Stuck requests" className="card space-y-3">
        <h2 className="text-lg font-semibold">Stuck join requests (&gt;24h pending)</h2>
        {stuck.length === 0 && <p className="text-sm text-slate-400">None right now.</p>}
        <ul className="space-y-2">
          {stuck.map((r: any) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3">
              <div className="text-sm">
                <p><span className="font-semibold">{r.requester_name}</span> &rarr; <span className="font-semibold">{r.team_name}</span> ({r.member_count} members, leader {r.leader_name})</p>
                <p className="text-xs text-slate-400">pending since {new Date(r.created_at).toLocaleString()}</p>
              </div>
              <button className="btn-ghost text-sm" onClick={() => resolveStuck(r.id)}>Cancel with reason</button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-slate-400">Resolution is cancel-with-reason only. Organizers never force-accept: seat limits belong to the race-proofed join path, not to operator overrides.</p>
      </section>

      <section aria-label="Audit log" className="card space-y-3">
        <h2 className="text-lg font-semibold">Audit log</h2>
        <form onSubmit={searchAudit} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-700">Action
            <input className="input mt-1" placeholder="team_created" value={auditFilter.action} onChange={(e) => setAuditFilter({ ...auditFilter, action: e.target.value })} />
          </label>
          <label className="text-xs text-slate-700">User ID
            <input className="input mt-1" placeholder="uuid" value={auditFilter.user_id} onChange={(e) => setAuditFilter({ ...auditFilter, user_id: e.target.value })} />
          </label>
          <label className="text-xs text-slate-700">Team ID
            <input className="input mt-1" placeholder="uuid" value={auditFilter.team_id} onChange={(e) => setAuditFilter({ ...auditFilter, team_id: e.target.value })} />
          </label>
          <button className="btn-primary" type="submit">Search</button>
          <button className="btn-ghost" type="button" onClick={exportCsv}>Export CSV</button>
        </form>
        {audit && (
          <ul className="max-h-80 space-y-1 overflow-auto text-sm" aria-label="Audit results">
            {audit.map((r: any) => (
              <li key={r.id} className="border-b border-line py-1">
                <span className="text-xs text-slate-400">{new Date(r.created_at).toLocaleString()}</span>{' '}
                <span className="font-medium">{r.action}</span>{' '}
                <span className="text-slate-700">{r.actor_name ?? 'system'}{r.subject_name ? ` -> ${r.subject_name}` : ''}{r.team_name ? ` (${r.team_name})` : ''}</span>
              </li>
            ))}
            {audit.length === 0 && <li className="text-slate-400">No matching entries.</li>}
          </ul>
        )}
        <p className="text-xs text-slate-400">The trail survives team deletion. Retention: keep for the event + 90 days, export before any manual cleanup (docs/operations.md).</p>
      </section>

      <section aria-label="Matching quality" className="card space-y-2">
        <h2 className="text-lg font-semibold">Matching quality (validation in progress)</h2>
        <p className="text-sm text-slate-700">
          {matching.impressions} suggestions served to {matching.users_served} participants ({matching.candidates_served} candidates).{' '}
          {matching.feedback_votes} usefulness votes, {matching.feedback_useful} positive.{' '}
          {matching.unique_pairs > 0 ? `${Math.round((100 * matching.candidate_joined_within_7d) / matching.unique_pairs)}% of served candidates joined a team within 7 days.` : ''}
        </p>
        <p className="text-xs text-slate-400">{matching.note}</p>
      </section>
    </div>
  );
}
