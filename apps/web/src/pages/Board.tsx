import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, newIdempotencyKey, ApiError } from '../api';
import { useAuth } from '../auth';
import { subscribeBoardChanges } from '../realtime';
import { useToast } from '../components/Toasts';

export default function Board() {
  const { token } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [board, setBoard] = useState<{ teams: any[]; people: any[]; next_teams_cursor: string | null; next_people_cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<'teams' | 'people'>('teams');
  const joinKeyRef = useRef(newIdempotencyKey()); // one key per attempt; regenerated after each outcome

  const refresh = useCallback(() => {
    api('/api/board?limit=24', { token }).then(setBoard).catch((e) => toast(e.message, 'error'));
  }, [token]);

  async function loadMore() {
    if (!board || loadingMore) return;
    const params = new URLSearchParams({ limit: '24' });
    if (tab === 'teams' && board.next_teams_cursor) params.set('teams_cursor', board.next_teams_cursor);
    if (tab === 'people' && board.next_people_cursor) params.set('people_cursor', board.next_people_cursor);
    if (!params.has('teams_cursor') && !params.has('people_cursor')) return;
    setLoadingMore(true);
    try {
      const next = await api(`/api/board?${params}`, { token });
      setBoard((prev) => prev && {
        teams: tab === 'teams' ? [...prev.teams, ...next.teams] : prev.teams,
        people: tab === 'people' ? [...prev.people, ...next.people] : prev.people,
        next_teams_cursor: tab === 'teams' ? next.next_teams_cursor : prev.next_teams_cursor,
        next_people_cursor: tab === 'people' ? next.next_people_cursor : prev.next_people_cursor,
      });
    } catch (e: any) { toast(e.message, 'error'); } finally { setLoadingMore(false); }
  }

  useEffect(() => {
    refresh();
    return subscribeBoardChanges(refresh, token);
  }, [refresh, token]);

  async function joinWithCode(e: FormEvent) {
    e.preventDefault();
    const key = joinKeyRef.current;
    setJoining(true); // optimistic state
    try {
      const res = await api('/api/teams/join-by-code', { method: 'POST', token, body: { code: code.trim() }, idempotencyKey: key });
      navigate(`/team/${res.team_id}`);
    } catch (err: any) {
      // rollback: restore the form, keep the same key so a manual retry replays safely
      setJoining(false);
      toast(err instanceof ApiError ? err.message : 'Join failed', 'error');
      if (err?.code !== 'request_in_flight') joinKeyRef.current = newIdempotencyKey();
    }
  }

  async function createTeam(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await api('/api/teams', { method: 'POST', token, body: { name: teamName.trim() }, idempotencyKey: newIdempotencyKey() });
      navigate(`/team/${res.team.id}`);
    } catch (err: any) {
      setCreating(false);
      toast(err.message, 'error');
    }
  }

  async function requestJoin(teamId: string) {
    try {
      await api(`/api/teams/${teamId}/requests`, { method: 'POST', token, body: {}, idempotencyKey: newIdempotencyKey() });
      toast('Request sent to the team leader');
      refresh();
    } catch (err: any) { toast(err.message, 'error'); }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="eyebrow mb-3">Discover. Connect. Build.</p><h1 className="page-heading">Find your people.</h1><p className="mt-3 text-slate-400">A great idea needs the right team. Meet yours here.</p></div>
        <Link to="/profile" className="btn-ghost">Edit your profile <span aria-hidden="true">↗</span></Link>
      </header>
      <div className="rounded-2xl border border-blue-100 bg-[#edf2ff] px-5 py-4 text-sm text-slate-700"><span className="font-semibold text-accent">Better together.</span> Browse open teams or discover people whose skills complement yours. Have an invite? Join with a code.</div>
      <div className="board-grid"><section aria-label="Discover teams and people" className="min-w-0">
      <div className="mb-5"><label className="label" htmlFor="board-search">Search loaded results</label><input id="board-search" className="input" type="search" placeholder="Search by name or skill..." value={search} onChange={(e) => setSearch(e.target.value)} /><p className="mt-1 text-xs text-slate-400">Filters the cards already loaded. Load more to explore further.</p></div>

      <div role="tablist" aria-label="Board views" className="board-tabs">
        <button role="tab" aria-selected={tab === 'teams'} className={tab === 'teams' ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab('teams')}>
          Teams looking ({board ? `${board.teams.length}${board.next_teams_cursor ? '+' : ''}` : '...'})
        </button>
        <button role="tab" aria-selected={tab === 'people'} className={tab === 'people' ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab('people')}>
          People looking ({board ? `${board.people.length}${board.next_people_cursor ? '+' : ''}` : '...'})
        </button>
      </div>

      {!board && <p className="text-slate-400">Loading board...</p>}

      {tab === 'teams' && board && (
        <ul className="mt-5 grid gap-4 sm:grid-cols-2" aria-label="Teams looking for members">
          {board.teams.filter((t) => `${t.name} ${t.leader_name} ${(t.wanted_skills ?? []).join(' ')}`.toLowerCase().includes(search.toLowerCase())).map((t) => (
            <li key={t.id} className="card team-card">
              <div className="mb-4 flex items-center justify-between"><span className="avatar" aria-hidden="true">{t.name.slice(0, 2).toUpperCase()}</span><span className="text-xs font-medium text-accent">Open for members</span></div>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/team/${t.id}`} className="font-semibold text-accent hover:underline">{t.name}</Link>
                <span className="badge" aria-label={`${t.member_count} of ${t.team_size_max} seats taken`}>
                  {t.member_count}/{t.team_size_max}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">Led by {t.leader_name}</p>
              {t.wanted_skills?.length > 0 && (
                <p className="mt-2 flex flex-wrap gap-1">{t.wanted_skills.map((s: string) => <span key={s} className="badge">{s}</span>)}</p>
              )}
              <div className="mt-auto flex gap-2 pt-5">
                <button className="btn-primary flex-1" onClick={() => requestJoin(t.id)}>Request to join</button>
                <Link className="btn-ghost" to={`/team/${t.id}`}>View</Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === 'teams' && board && board.teams.length === 0 && (
        <p className="text-slate-400">No teams looking right now. Create one!</p>
      )}

      {tab === 'teams' && board?.next_teams_cursor && (
        <button className="btn-secondary mx-auto block" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading...' : 'Load more teams'}
        </button>
      )}

      {tab === 'people' && board && (
        <ul className="mt-5 grid gap-4 sm:grid-cols-2" aria-label="People looking for teams">
          {board.people.filter((p) => `${p.display_name} ${(p.skills ?? []).join(' ')}`.toLowerCase().includes(search.toLowerCase())).map((p) => (
            <li key={p.id} className="card"><div className="avatar mb-3" aria-hidden="true">{p.display_name.slice(0, 2).toUpperCase()}</div>
              <p className="font-semibold">{p.display_name}</p>
              <p className="text-xs text-slate-400">{p.timezone}</p>
              <p className="mt-2 flex flex-wrap gap-1">{(p.skills ?? []).map((s: string) => <span key={s} className="badge">{s}</span>)}</p>
            </li>
          ))}
        </ul>
      )}

      {tab === 'people' && board && board.people.length === 0 && (
        <p className="text-slate-400">Nobody is looking right now.</p>
      )}

      {tab === 'people' && board?.next_people_cursor && (
        <button className="btn-secondary mx-auto block" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading...' : 'Load more people'}
        </button>
      )}
      {search && board && <p className="mt-4 text-xs text-slate-400" role="status">Showing loaded results matching "{search}". Clear search to see all loaded cards.</p>}
      </section>      <aside className="board-actions" aria-label="Team actions">
        <form onSubmit={joinWithCode} className="card space-y-3" aria-label="Join a team with an invite code">
          <h2 className="font-semibold">Have an invite code?</h2>
          <label className="label" htmlFor="code">Invite code</label>
          <input id="code" className="input font-mono tracking-widest" placeholder="X7K9PQ2M4N" value={code} onChange={(e) => setCode(e.target.value)} required />
          <button className="btn-primary w-full" disabled={joining}>
            {joining ? 'Joining...' : 'Join team'}
          </button>
        </form>
        <form onSubmit={createTeam} className="card space-y-3" aria-label="Create a team">
          <h2 className="font-semibold">Start a team</h2>
          <label className="label" htmlFor="tname">Team name</label>
          <input id="tname" className="input" value={teamName} onChange={(e) => setTeamName(e.target.value)} required />
          <button className="btn-ghost w-full" disabled={creating}>{creating ? 'Creating...' : 'Create team'}</button>
        </form>
      </aside>
</div>
    </div>
  );
}
