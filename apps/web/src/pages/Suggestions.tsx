import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toasts';

export default function Suggestions() {
  const { token } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    localStorage.setItem('tf_seen_suggestions', '1');
    api('/api/suggestions', { token }).then(setData).catch((e) => toast(e.message, 'error'));
  }, [token]);

  if (!data) return <p className="text-slate-400">Loading suggestions...</p>;

  return (
    <div className="space-y-4">
      <p className="eyebrow">Made for your skill set</p><h1 className="page-heading">Suggested teammates</h1><p className="text-slate-400">Find a different perspective. Scores explain why each person might fit.</p>
      <p className="rounded-xl border border-line bg-white p-4 text-sm text-slate-400">Ranking: <code className="text-accent">{data.scoring}</code></p>
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
          </li>
        ))}
      </ul>
      {data.suggestions.length === 0 && <p className="text-slate-400">No suggestions yet - fill in your skills on your profile.</p>}
    </div>
  );
}
