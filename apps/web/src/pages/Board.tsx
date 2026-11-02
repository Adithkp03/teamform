import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, newIdempotencyKey, ApiError } from '../api';
import { useAuth } from '../auth';
import { subscribeBoardChanges } from '../realtime';
import { useToast } from '../components/Toasts';

type BoardData = { teams: any[]; people: any[]; next_teams_cursor: string | null; next_people_cursor: string | null };

export default function Board() {
  const { token } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [skillFilter, setSkillFilter] = useState('');
  const [tzFilter, setTzFilter] = useState('');
  const [me, setMe] = useState<any>(null);
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<'teams' | 'people'>('teams');
  const [pendingTeams, setPendingTeams] = useState<Record<string, 'sending' | 'sent'>>({});
  const joinKeyRef = useRef(newIdempotencyKey()); // one key per attempt; regenerated after each outcome
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryString = useCallback((extra?: Record<string, string>) => {
    const params = new URLSearchParams({ limit: '24' });
    if (search.trim()) params.set('q', search.trim());
    if (skillFilter.trim()) params.set('skill', skillFilter.trim());
    if (tzFilter.trim()) params.set('timezone', tzFilter.trim());
    for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
    return params.toString();
  }, [search, skillFilter, tzFilter]);

  const refresh = useCallback(() => {
    api(`/api/board?${queryString()}`, { token }).then(setBoard).catch((e) => toast(e.message, 'error'));
  }, [token, queryString]);

  // Server-side search: debounce typing, then re-query the whole board with
  // the current filters. Filters are resent on every page load below.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refresh, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [refresh]);

  useEffect(() => {
    api('/api/me', { token }).then((d) => setMe(d.profile)).catch(() => {});
  }, [token]);

  useEffect(() => {
    refresh();
    return subscribeBoardChanges(refresh, token);
  }, [refresh, token]);

  async function loadMore() {
    if (!board || loadingMore) return;
    const extra: Record<string, string> = {};
    if (tab === 'teams' && board.next_teams_cursor) extra.teams_cursor = board.next_teams_cursor;
    if (tab === 'people' && board.next_people_cursor) extra.people_cursor = board.next_people_cursor;
    if (!extra.teams_cursor && !extra.people_cursor) return;
    setLoadingMore(true);
    try {
      const next = await api(`/api/board?${queryString(extra)}`, { token });
      setBoard((prev) => prev && {
        teams: tab === 'teams' ? [...prev.teams, ...next.teams] : prev.teams,
        people: tab === 'people' ? [...prev.people, ...next.people] : prev.people,
        next_teams_cursor: tab === 'teams' ? next.next_teams_cursor : prev.next_teams_cursor,
        next_people_cursor: tab === 'people' ? next.next_people_cursor : prev.next_people_cursor,
      });
    } catch (e: any) { toast(e.message, 'error'); } finally { setLoadingMore(false); }
  }

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
    setPendingTeams((p) => ({ ...p, [teamId]: 'sending' }));
    try {
      await api(`/api/teams/${teamId}/requests`, { method: 'POST', token, body: {}, idempotencyKey: newIdempotencyKey() });
      setPendingTeams((p) => ({ ...p, [teamId]: 'sent' }));
      toast('Request sent - the team leader will review it.');
      refresh();
    } catch (err: any) {
      setPendingTeams((p) => {
        const next = { ...p };
        if (err?.code === 'request_in_flight' || err?.status === 409) next[teamId] = 'sent';
        else delete next[teamId];
        return next;
      });
      const code = err?.code;
      if (code === 'team_full') toast('This team just filled up - browse other teams below.', 'error');
      else if (code === 'already_member' || code === 'member_of_other_team') toast('You are already on a team for this hackathon.', 'error');
      else if (err?.status === 409) toast('You already have a pending request with this team.', 'error');
      else toast(err.message, 'error');
      refresh();
    }
  }

  const mySkills: string[] = me?.skills ?? [];
  const myTz: string | undefined = me?.timezone;

  function teamMatchReasons(t: any): string[] {
    const reasons: string[] = [];
    const wanted: string[] = t.wanted_skills ?? [];
    const mine = wanted.filter((s) => mySkills.some((m) => m.toLowerCase() === s.toLowerCase()));
    if (mine.length > 0) reasons.push(`Wants your ${mine.slice(0, 2).join(' + ')}`);
    if (t.leader_timezone && myTz && t.leader_timezone === myTz) reasons.push('Same timezone');
    const open = (t.team_size_max ?? 0) - (t.member_count ?? 0);
    if (open > 0) reasons.push(`${open} open seat${open === 1 ? '' : 's'}`);
    return reasons;
  }

  function personMatchReasons(p: any): string[] {
    const reasons: string[] = [];
    const skills: string[] = p.skills ?? [];
    const shared = skills.filter((s) => mySkills.some((m) => m.toLowerCase() === s.toLowerCase()));
    if (shared.length > 0) reasons.push(`${shared.length} shared skill${shared.length === 1 ? '' : 's'}: ${shared.slice(0, 3).join(', ')}`);
    if (p.timezone && myTz && p.timezone === myTz) reasons.push('Same timezone');
    return reasons;
  }

  const hasFilters = !!(search.trim() || skillFilter.trim() || tzFilter.trim());

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="eyebrow mb-3">Discover. Connect. Build.</p><h1 className="page-heading">Find your people.</h1><p className="mt-3 text-slate-400">A great idea needs the right team. Meet yours here.</p></div>
        <Link to="/profile" className="btn-ghost">Edit your profile <span aria-hidden="true">↗</span></Link>
      </header>
      <div className="rounded-2xl border border-blue-100 bg-[#edf2ff] px-5 py-4 text-sm text-slate-700"><span className="font-semibold text-accent">Better together.</span> Browse open teams or discover people whose skills complement yours. Have an invite? Join with a code.</div>
      <div className="board-grid"><section aria-label="Discover teams and people" className="min-w-0">
      <div className="mb-5 space-y-3">
        <div><label className="label" htmlFor="board-search">Search the whole board</label><input id="board-search" className="input" type="search" placeholder="Search by team or person name..." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="board-skill">Filter by skill</label><input id="board-skill" className="input" placeholder="e.g. React" value={skillFilter} onChange={(e) => setSkillFilter(e.target.value)} /></div>
          <div><label className="label" htmlFor="board-tz">Filter by timezone</label><input id="board-tz" className="input" placeholder="e.g. Asia/Calcutta" value={tzFilter} onChange={(e) => setTzFilter(e.target.value)} /></div>
        </div>
        <p className="text-xs text-slate-400">Searches and filters apply across the entire board, not just loaded cards, and stay active as you load more.</p>
      </div>

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
          {board.teams.map((t) => {
            const reasons = teamMatchReasons(t);
            const state = pendingTeams[t.id];
            return (
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
              {reasons.length > 0 && (
                <p className="mt-2 text-xs text-emerald-700" aria-label="Why this team matches you">{reasons.join(' · ')}</p>
              )}
              <div className="mt-auto flex gap-2 pt-5">
                {state === 'sent' ? (
                  <span className="btn-ghost flex-1 text-center" role="status">Request pending - the leader will review it</span>
                ) : (
                  <button className="btn-primary flex-1" onClick={() => requestJoin(t.id)} disabled={state === 'sending'}>
                    {state === 'sending' ? 'Sending...' : 'Request to join'}
                  </button>
                )}
                <Link className="btn-ghost" to={`/team/${t.id}`}>View</Link>
              </div>
            </li>
          ); })}
        </ul>
      )}

      {tab === 'teams' && board && board.teams.length === 0 && (
        <p className="text-slate-400">{hasFilters ? 'No teams match these filters. Try clearing one.' : 'No teams looking right now. Create one!'}</p>
      )}

      {tab === 'teams' && board?.next_teams_cursor && (
        <button className="btn-secondary mx-auto block" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading...' : 'Load more teams'}
        </button>
      )}

      {tab === 'people' && board && (
        <ul className="mt-5 grid gap-4 sm:grid-cols-2" aria-label="People looking for teams">
          {board.people.map((p) => {
            const reasons = personMatchReasons(p);
            return (
            <li key={p.id} className="card"><div className="avatar mb-3" aria-hidden="true">{p.display_name.slice(0, 2).toUpperCase()}</div>
              <p className="font-semibold">{p.display_name}</p>
              <p className="text-xs text-slate-400">{p.timezone}</p>
              <p className="mt-2 flex flex-wrap gap-1">{(p.skills ?? []).map((s: string) => <span key={s} className="badge">{s}</span>)}</p>
              {reasons.length > 0 && (
                <p className="mt-2 text-xs text-emerald-700" aria-label="Why this person matches you">{reasons.join(' · ')}</p>
              )}
            </li>
          ); })}
        </ul>
      )}

      {tab === 'people' && board && board.people.length === 0 && (
        <p className="text-slate-400">{hasFilters ? 'Nobody matches these filters. Try clearing one.' : 'Nobody is looking right now.'}</p>
      )}

      {tab === 'people' && board?.next_people_cursor && (
        <button className="btn-secondary mx-auto block" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading...' : 'Load more people'}
        </button>
      )}
      {hasFilters && board && <p className="mt-4 text-xs text-slate-400" role="status">Filters active across the whole board. Clear them to see everyone.</p>}
      </section>      <aside className="board-actions" aria-label="Team actions">
        <form onSubmit={joinWithCode} className="card space-y-3" aria-label="Join a team with an invite code">
          <h2 className="font-semibold">Have an invite code?</h2>
          <p className="text-xs text-slate-400">A code joins you instantly - no leader approval needed.</p>
          <label className="label" htmlFor="code">Invite code</label>
          <input id="code" className="input font-mono tracking-widest" placeholder="X7K9PQ2M4N" value={code} onChange={(e) => setCode(e.target.value)} required />
          <button className="btn-primary w-full" disabled={joining}>
            {joining ? 'Joining...' : 'Join with code'}
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
