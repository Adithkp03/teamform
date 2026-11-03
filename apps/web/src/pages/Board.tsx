import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, newIdempotencyKey, ApiError } from '../api';
import { useAuth } from '../auth';
import { subscribeBoardChanges } from '../realtime';
import { useToast } from '../components/Toasts';
import { useInvitePerson } from '../useInvite';

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
  const [minSeats, setMinSeats] = useState('');
  const [me, setMe] = useState<any>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => localStorage.getItem('tf_onboarding_dismissed') === '1');
  const [sawSuggestions, setSawSuggestions] = useState(() => localStorage.getItem('tf_seen_suggestions') === '1');
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [teamName, setTeamName] = useState('');
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<'teams' | 'people'>('teams');
  const [pendingTeams, setPendingTeams] = useState<Record<string, 'sending' | 'sent'>>({});
  const joinKeyRef = useRef(newIdempotencyKey()); // one key per attempt; regenerated after each outcome
  const [invitations, setInvitations] = useState<any[]>([]);
  const [invBusy, setInvBusy] = useState<Record<string, boolean>>({});
  // Sequence guard: only the newest board response may land, so a slow older
  // reply can never overwrite fresher results (stale-response race fix).
  const seqRef = useRef(0);
  // Loaded-coverage tracking: how many items of each list are currently
  // displayed (plus an in-flight loadMore allowance). A background refresh of
  // the SAME result set asks for at least this many rows, so live updates can
  // never snap the board back to page 1 or resurrect a finished Load-more.
  // Filter changes zero these (a new result set starts at page 1).
  const loadedTeamsRef = useRef(0);
  const loadedPeopleRef = useRef(0);
  // The demand pump: refs count displayed items PLUS in-flight loadMore
  // demand. Whenever any fetch settles (refresh commit/failure, loadMore
  // landing or being discarded), queued demand that exceeds the displayed
  // coverage triggers one next-page fetch - so a click swallowed by a racing
  // refresh always advances once the board settles, under any interleaving.
  const boardRef = useRef<{ teams: any[]; people: any[]; next_teams_cursor: string | null; next_people_cursor: string | null } | null>(null);
  const loadingMoreRef = useRef(false);
  const loadMoreRef = useRef<() => void>(() => {});
  const pump = () => {
    if (loadingMoreRef.current) return; // a page fetch is in flight; its settle re-pumps
    const b = boardRef.current;
    if (!b) return;
    const owedTeams = loadedTeamsRef.current > b.teams.length && b.next_teams_cursor;
    const owedPeople = loadedPeopleRef.current > b.people.length && b.next_people_cursor;
    if (owedTeams || owedPeople) loadMoreRef.current();
  };

  const queryString = useCallback((extra?: Record<string, string>) => {
    const params = new URLSearchParams({ limit: '24' });
    if (search.trim()) params.set('q', search.trim());
    if (skillFilter.trim()) params.set('skill', skillFilter.trim());
    if (tzFilter.trim()) params.set('timezone', tzFilter.trim());
    if (minSeats) params.set('min_open_seats', minSeats);
    for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
    return params.toString();
  }, [search, skillFilter, tzFilter, minSeats]);

  // The exact query that produced the currently displayed page: loadMore must
  // extend THAT result set. Reading live filter state here instead would let a
  // filter change inside the debounce window append a mismatched page (the
  // sequence guard only trips once the debounced refresh actually fires).
  const boardQueryRef = useRef('');

  const refresh = useCallback(() => {
    const seq = ++seqRef.current;
    const qs = queryString();
    // Evaluated live below: a refresh may START before any commit of this
    // query (boardQueryRef still empty) yet COMMIT after one - sameness must
    // be re-judged then, or a same-set refresh wrongly replaces the board
    // with page 1 and stomps pages loaded meanwhile (the snapback race).
    const sameSetNow = () => qs === boardQueryRef.current;
    const sameSet = sameSetNow();
    // Same result set (live update or reconnect): restore the coverage the
    // user already loaded instead of snapping back to page 1. The server caps
    // one page at 200 rows, so wider coverage is restored with sequential
    // cursor pages, committed in a single update - no intermediate snapback,
    // no new snapback past 200, no duplicates (pages merge by id).
    const target = sameSet ? Math.max(24, loadedTeamsRef.current, loadedPeopleRef.current) : 24;
    const collect = async () => {
      let teams: any[] = [];
      let people: any[] = [];
      let tc: string | null = null;
      let pc: string | null = null;
      let teamsDone = false;
      let peopleDone = false;
      let first: any = null;
      for (let guard = 0; guard < 50; guard++) {
        // Re-read the live coverage every page: a loadMore racing this
        // refresh bumps the refs while pages are in flight, and the refresh
        // must cover that page too instead of stomping it on commit.
        const liveTarget = sameSetNow() ? Math.max(target, loadedTeamsRef.current, loadedPeopleRef.current) : target;
        const params = new URLSearchParams(qs);
        const remaining = liveTarget - Math.max(teams.length, people.length);
        params.set('limit', String(Math.min(200, Math.max(24, remaining))));
        if (!teamsDone && tc) params.set('teams_cursor', tc);
        if (!peopleDone && pc) params.set('people_cursor', pc);
        const d = await api(`/api/board?${params}`, { token });
        if (seq !== seqRef.current) return null; // a newer refresh owns the board
        first = first ?? d;
        if (!teamsDone) {
          const seen = new Set(teams.map((t: any) => t.id));
          teams = [...teams, ...d.teams.filter((t: any) => !seen.has(t.id))];
          tc = d.next_teams_cursor;
          teamsDone = teams.length >= liveTarget || !tc;
        }
        if (!peopleDone) {
          const seen = new Set(people.map((p: any) => p.id));
          people = [...people, ...d.people.filter((p: any) => !seen.has(p.id))];
          pc = d.next_people_cursor;
          peopleDone = people.length >= liveTarget || !pc;
        }
        if (teamsDone && peopleDone) break;
      }
      return { ...first, teams, people, next_teams_cursor: tc, next_people_cursor: pc };
    };
    // Coverage can grow while the final page is in flight (a loadMore click
    // landing mid-refresh): re-check at commit and refetch rather than commit
    // a board that shows LESS than the user already loaded (the snapback).
    const run = async (attempt: number): Promise<any> => {
      const d = await collect();
      if (!d || seq !== seqRef.current) return null;
      if (sameSetNow() && attempt < 3) {
        const wanted = Math.max(loadedTeamsRef.current, loadedPeopleRef.current);
        const covered = Math.max(d.teams.length, d.people.length);
        if (wanted > covered && (d.next_teams_cursor || d.next_people_cursor)) return run(attempt + 1);
      }
      return d;
    };
    return run(0)
      .then((d) => {
        if (!d || seq !== seqRef.current) return;
        boardQueryRef.current = qs; // base query (page-1 limit) for loadMore and same-set comparison
        // NEVER lower the coverage allowance on ANY commit: the refs are a
        // demand ledger, and a loadMore click may have recorded demand before
        // this refresh even started (the mount race: a superseded first
        // refresh leaves boardQueryRef empty, so this commit judges itself a
        // new query - but the demand was real and the pump must still owe the
        // page). Genuine query changes zero the refs in the input effect
        // before the new-query refresh fires, so unbounded growth is
        // impossible; a shrunken result set is bounded by the null cursor.
        loadedTeamsRef.current = Math.max(loadedTeamsRef.current, d.teams.length);
        loadedPeopleRef.current = Math.max(loadedPeopleRef.current, d.people.length);
        setBoard(d);
        pump(); // a loadMore click swallowed by this refresh left owed demand
      })
      .catch((e) => { if (seq === seqRef.current) { toast(e.message, 'error'); pump(); } });
  }, [token, queryString]);

  const fetchInvitations = useCallback(() => {
    api('/api/me/invitations', { token }).then((d) => setInvitations(d.invitations)).catch(() => {});
  }, [token]);

  // Server-side search: typing and filter changes re-query the whole board
  // once, after a debounce (previously each change fired BOTH an immediate
  // and a debounced request, and either response could land last).
  // Query identity is derived from the actual inputs, NOT the callback's
  // identity: an access-token rotation (or the cookie boot restore) recreates
  // `refresh` with the SAME query, and must neither reset coverage nor
  // discard a loadMore for the same result set - the refresh is same-set and
  // preserves loaded pages.
  const queryInputsRef = useRef('');
  useEffect(() => {
    const key = queryString();
    const queryChanged = queryInputsRef.current !== '' && queryInputsRef.current !== key;
    queryInputsRef.current = key;
    seqRef.current++;
    if (queryChanged) {
      // Result set is about to change: start from page 1. A loadMore page
      // request still in flight belongs to the pre-change set and is
      // discarded by the sequence guard above.
      loadedTeamsRef.current = 0;
      loadedPeopleRef.current = 0;
    }
    const t = setTimeout(() => refreshRef.current(), 350);
    return () => clearTimeout(t);
  }, [queryString, token]);

  useEffect(() => {
    api('/api/me', { token }).then((d) => setMe(d.profile)).catch(() => {});
  }, [token]);

  // Live updates: one stable subscription per session; it always refetches
  // with the CURRENT filters and reloads the invitation inbox (invitation
  // events are invitee-private server-side).
  const refreshRef = useRef(refresh);
  const invRef = useRef(fetchInvitations);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => { invRef.current = fetchInvitations; }, [fetchInvitations]);
  useEffect(() => {
    fetchInvitations();
    return subscribeBoardChanges(() => { refreshRef.current(); invRef.current(); }, token);
  }, [token, fetchInvitations]);

  async function answerInvitation(invId: string, action: 'accept' | 'decline') {
    setInvBusy((b) => ({ ...b, [invId]: true }));
    try {
      const res = await api(`/api/invitations/${invId}/${action}`, { method: 'POST', token, body: {} });
      toast(action === 'accept' ? 'You joined the team.' : 'Invitation declined.');
      setInvitations((list) => list.filter((i) => i.id !== invId));
      refresh();
      api('/api/me', { token }).then((d) => setMe(d.profile)).catch(() => {});
      if (action === 'accept' && res?.team_id) navigate(`/team/${res.team_id}`);
    } catch (e: any) {
      toast(e.message, 'error');
      fetchInvitations();
    } finally {
      setInvBusy((b) => ({ ...b, [invId]: false }));
    }
  }

  useEffect(() => { loadMoreRef.current = () => { void loadMore(); }; });
  useEffect(() => { boardRef.current = board; });

  async function loadMore() {
    if (!board || loadingMoreRef.current) return;
    const extra: Record<string, string> = {};
    if (tab === 'teams' && board.next_teams_cursor) extra.teams_cursor = board.next_teams_cursor;
    if (tab === 'people' && board.next_people_cursor) extra.people_cursor = board.next_people_cursor;
    if (!extra.teams_cursor && !extra.people_cursor) return;
    loadingMoreRef.current = true;
    // Same sequence guard as refresh: if filters change while this page
    // request is in flight, the refresh owns the board and this stale page
    // must be discarded instead of appended to the new results.
    const seq = seqRef.current;
    // Optimistic coverage allowance: a same-set refresh racing this request
    // over-fetches by a page (harmless) instead of under-fetching (snapback).
    if (tab === 'teams') loadedTeamsRef.current += 24; else loadedPeopleRef.current += 24;
    setLoadingMore(true);
    try {
      const base = new URLSearchParams(boardQueryRef.current || queryString());
      for (const [k, v] of Object.entries(extra)) base.set(k, v);
      const next = await api(`/api/board?${base}`, { token });
      if (seq !== seqRef.current) return; // a refresh owns the board now; its coverage includes this page
      setBoard((prev) => {
        if (!prev) return prev;
        const seenT = new Set(prev.teams.map((t: any) => t.id));
        const seenP = new Set(prev.people.map((p: any) => p.id));
        const teams = tab === 'teams' ? [...prev.teams, ...next.teams.filter((t: any) => !seenT.has(t.id))] : prev.teams;
        const people = tab === 'people' ? [...prev.people, ...next.people.filter((p: any) => !seenP.has(p.id))] : prev.people;
        loadedTeamsRef.current = teams.length;
        loadedPeopleRef.current = people.length;
        return {
          teams,
          people,
          next_teams_cursor: tab === 'teams' ? next.next_teams_cursor : prev.next_teams_cursor,
          next_people_cursor: tab === 'people' ? next.next_people_cursor : prev.next_people_cursor,
        };
      });
    } catch (e: any) { toast(e.message, 'error'); } finally { loadingMoreRef.current = false; setLoadingMore(false); pump(); }
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
      setFormError(err.message); // team name input is preserved
    }
  }

  async function cancelRequest(requestId: string, teamId: string) {
    setPendingTeams((p) => ({ ...p, [teamId]: 'sending' }));
    try {
      await api(`/api/requests/${requestId}`, { method: 'DELETE', token });
      setPendingTeams((p) => { const n = { ...p }; delete n[teamId]; return n; });
      toast('Request cancelled.');
      refresh();
    } catch (e: any) {
      setPendingTeams((p) => ({ ...p, [teamId]: 'sent' }));
      toast(e.message, 'error');
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
      const code = err?.code;
      setPendingTeams((p) => {
        const next = { ...p };
        // "sent" requires a server-confirmed EXISTING pending request:
        // request_already_pending means the unique one-pending-per-team index
        // was hit, so a persisted request provably exists (and the refresh
        // below attaches its real cancel id via my_pending_request_id).
        // request_in_flight only proves concurrent in-flight work - it may
        // still fail - and conflicts like team_full/already_in_team mean no
        // request was created. None of those may show a cancelable pending.
        if (code === 'request_already_pending') next[teamId] = 'sent';
        else delete next[teamId];
        return next;
      });
      if (code === 'team_full') toast('This team just filled up - browse other teams below.', 'error');
      else if (code === 'already_in_team' || code === 'already_member' || code === 'member_of_other_team') toast('You are already on a team for this hackathon.', 'error');
      else if (code === 'request_already_pending') toast('You already have a pending request with this team.', 'error');
      else if (code === 'request_in_flight') toast('Your previous attempt is still being processed - the board will update.', 'error');
      else toast(err.message, 'error');
      refresh();
    }
  }

  const { invite: invitePerson, states: inviteStates } = useInvitePerson(me?.my_team_id, () => { refresh(); });
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

  const hasFilters = !!(search.trim() || skillFilter.trim() || tzFilter.trim() || minSeats);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="eyebrow mb-3">Discover. Connect. Build.</p><h1 className="page-heading">Find your people.</h1><p className="mt-3 text-slate-400">A great idea needs the right team. Meet yours here.</p></div>
        <Link to="/profile" className="btn-ghost">Edit your profile <span aria-hidden="true">↗</span></Link>
      </header>
      <div className="rounded-2xl border border-blue-100 bg-[#edf2ff] px-5 py-4 text-sm text-slate-700"><span className="font-semibold text-accent">Better together.</span> Browse open teams or discover people whose skills complement yours. Have an invite? Join with a code.</div>
      {me && !onboardingDismissed && !me.my_team_id && (
        <section aria-label="Getting started checklist" className="card space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Get set up in three steps</h2>
            <button
              className="btn-ghost !min-h-[36px] px-3 py-1 text-xs"
              aria-label="Dismiss getting started checklist"
              onClick={() => { localStorage.setItem('tf_onboarding_dismissed', '1'); setOnboardingDismissed(true); }}
            >Dismiss</button>
          </div>
          <ol className="space-y-2 text-sm">
            {[
              { done: !!(me.display_name && me.skills?.length), label: 'Complete your profile with your skills', link: { to: '/profile', text: 'Edit profile' } },
              { done: false, label: 'Join a team below, start your own, or use an invite code', link: null },
              { done: sawSuggestions, label: 'Meet teammates picked for your skill set', link: { to: '/suggestions', text: 'See suggestions' } },
            ].map((step) => (
              <li key={step.label} className="flex items-center gap-2">
                {step.done
                  ? <span className="font-bold text-emerald-700" aria-hidden="true">✓</span>
                  : <span className="inline-block h-3.5 w-3.5 shrink-0 rounded-sm border border-slate-400" aria-hidden="true" />}
                <span className="sr-only">{step.done ? 'Done: ' : 'To do: '}</span>
                <span className={step.done ? 'text-slate-400 line-through' : ''}>{step.label}</span>
                {!step.done && step.link && <Link className="text-accent hover:underline" to={step.link.to}>{step.link.text}</Link>}
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="board-grid"><section aria-label="Discover teams and people" className="min-w-0">
      <div className="mb-5 space-y-3">
        <div><label className="label" htmlFor="board-search">Search the whole board</label><input id="board-search" className="input" type="search" placeholder="Search by team or person name..." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="board-skill">Filter by skill</label><input id="board-skill" className="input" placeholder="e.g. React" value={skillFilter} onChange={(e) => setSkillFilter(e.target.value)} /></div>
          <div><label className="label" htmlFor="board-tz">Filter by timezone</label><input id="board-tz" className="input" placeholder="e.g. Asia/Calcutta" value={tzFilter} onChange={(e) => setTzFilter(e.target.value)} /></div>
          <div><label className="label" htmlFor="board-seats">Min open seats</label><input id="board-seats" className="input" type="number" min={1} max={20} placeholder="e.g. 2" value={minSeats} onChange={(e) => setMinSeats(e.target.value)} /></div>
        </div>
        <p className="text-xs text-slate-400">Searches and filters apply across the entire board, not just loaded cards, and stay active as you load more.</p>
      </div>

      {invitations.length > 0 && (
        <section aria-label="Team invitations" className="mb-5 space-y-3">
          <h2 className="font-semibold">Teams inviting you ({invitations.length})</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {invitations.map((inv) => (
              <li key={inv.id} className="card border-l-4 border-l-accent">
                <p className="font-semibold">{inv.team_name}</p>
                <p className="text-xs text-slate-400">
                  {inv.member_count}/{inv.team_size_max} members - invited by {inv.invited_by_name}
                </p>
                <div className="mt-3 flex gap-2">
                  <button className="btn-primary flex-1" disabled={!!invBusy[inv.id]} onClick={() => answerInvitation(inv.id, 'accept')}>Accept</button>
                  <button className="btn-ghost" disabled={!!invBusy[inv.id]} onClick={() => answerInvitation(inv.id, 'decline')}>Decline</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

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
            const state = pendingTeams[t.id] ?? (t.my_pending_request_id ? 'sent' : undefined);
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
                {state === 'sent' && t.my_pending_request_id && (
                  <button className="btn-ghost" aria-label={`Cancel your join request to ${t.name}`} onClick={() => cancelRequest(t.my_pending_request_id, t.id)}>Cancel</button>
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
              {me?.my_team_id && (
                <div className="mt-3">
                  {inviteStates[p.id] === 'sent' ? (
                    <span className="btn-ghost w-full text-center" role="status">Invited - waiting for their answer</span>
                  ) : (
                    <button className="btn-primary w-full" onClick={() => invitePerson(p.id)} disabled={inviteStates[p.id] === 'sending'}>
                      {inviteStates[p.id] === 'sending' ? 'Inviting...' : 'Invite to your team'}
                    </button>
                  )}
                </div>
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
          {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
        </form>
      </aside>
</div>
    </div>
  );
}
