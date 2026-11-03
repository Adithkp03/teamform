import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toasts';
import { useInvitePerson } from '../useInvite';

export default function Suggestions() {
  const { token } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<any>(null);
  const [votes, setVotes] = useState<Record<string, boolean>>({});
  const [me, setMe] = useState<any>(null);
  const { invite, states: inviteStates } = useInvitePerson(me?.my_team_id);

  useEffect(() => {
    localStorage.setItem('tf_seen_suggestions', '1');
    api('/api/suggestions', { token }).then(setData).catch((e) => toast(e.message, 'error'));
    api('/api/me', { token }).then((d) => setMe(d.profile)).catch(() => {});
  }, [token]);

  async function vote(candidateId: string, useful: boolean) {
    // One vote per suggestion; voting again changes it. Server upserts.
    setVotes((v) => ({ ...v, [candidateId]: useful }));
    try {
      await api('/api/suggestions/feedback', { method: 'POST', token, body: { candidate_id: candidateId, useful } });
    } catch (e: any) {
      setVotes((v) => { const n = { ...v }; delete n[candidateId]; return n; });
      toast(e.message, 'error');
    }
  }

  if (!data) return <p className="text-slate-400">Loading suggestions...</p>;

  return (
    <div className="space-y-4">
      <p className="eyebrow">Made for your skill set</p><h1 className="page-heading">Suggested teammates</h1><p className="text-slate-400">Find a different perspective. Scores explain why each person might fit.</p>
      <p className="rounded-xl border border-line bg-white p-4 text-sm text-slate-400">Ranking: <code className="text-accent">{data.scoring}</code></p>
      <p className="text-xs text-slate-400">Scores are a transparent heuristic, not a proven predictor - we are validating them against real join outcomes and your votes. Telling us whether a suggestion was useful directly improves this check.</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {data.suggestions.map((s: any) => (
          <li key={s.id} className="card">
            <div className="flex items-center justify-between">
              <p className="font-semibold">{s.display_name}</p>
              <span className="badge" aria-label={`score ${s.score}`}>score {s.score}</span>
            </div>
            <p className="text-xs text-slate-400">{s.timezone}</p>
            <p className="mt-1 text-sm text-slate-700">{s.reason}</p>
            <div className="mt-2 space-y-1">
              {(s.complementary_skill_names ?? []).length > 0 && (
                <p className="flex flex-wrap items-center gap-1 text-xs text-slate-400">
                  <span className="mr-1">Adds:</span>
                  {s.complementary_skill_names.map((x: string) => <span key={x} className="badge border-accent/50 text-accent">{x}</span>)}
                </p>
              )}
              {(s.shared_skill_names ?? []).length > 0 && (
                <p className="flex flex-wrap items-center gap-1 text-xs text-slate-400">
                  <span className="mr-1">Shared:</span>
                  {s.shared_skill_names.map((x: string) => <span key={x} className="badge">{x}</span>)}
                </p>
              )}
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-1 text-xs text-slate-400" aria-label="score breakdown">
              <div><dt>Complements you</dt><dd>{s.complementary_skills} x2</dd></div>
              <div><dt>Shared skills</dt><dd>{s.shared_skills} x1</dd></div>
              <div><dt>Timezone fit</dt><dd>{s.timezone_fit}</dd></div>
            </dl>
            {me?.my_team_id && (
              <div className="mt-3">
                {inviteStates[s.id] === 'sent' ? (
                  <span className="btn-ghost w-full text-center" role="status">Invited - waiting for their answer</span>
                ) : (
                  <button className="btn-primary w-full" onClick={() => invite(s.id)} disabled={inviteStates[s.id] === 'sending'}>
                    {inviteStates[s.id] === 'sending' ? 'Inviting...' : `Invite ${s.display_name.split(' ')[0]} to your team`}
                  </button>
                )}
              </div>
            )}
            {!me?.my_team_id && (
              <p className="mt-3 text-xs text-slate-400">Start or join a team to invite them to it.</p>
            )}
            <div className="mt-3 flex items-center gap-2 border-t border-line pt-2" role="group" aria-label={`Was the suggestion ${s.display_name} useful?`}>
              <span className="text-xs text-slate-400">Useful?</span>
              <button
                type="button"
                aria-pressed={votes[s.id] === true}
                onClick={() => vote(s.id, true)}
                className={`badge ${votes[s.id] === true ? 'border-accent/50 text-accent' : ''}`}
              >Yes</button>
              <button
                type="button"
                aria-pressed={votes[s.id] === false}
                onClick={() => vote(s.id, false)}
                className={`badge ${votes[s.id] === false ? 'border-accent/50 text-accent' : ''}`}
              >No</button>
              {votes[s.id] !== undefined && <span className="text-xs text-slate-400">Thanks - recorded.</span>}
            </div>
          </li>
        ))}
      </ul>
      {data.suggestions.length === 0 && <p className="text-slate-400">No suggestions yet - fill in your skills on your profile.</p>}
    </div>
  );
}
