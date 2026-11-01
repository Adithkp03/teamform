import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toasts';

export default function Suggestions() {
  const { token } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api('/api/suggestions', { token }).then(setData).catch((e) => toast(e.message, 'error'));
  }, [token]);

  if (!data) return <p className="text-slate-400">Loading suggestions...</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Suggested teammates</h1>
      <p className="text-sm text-slate-400">Ranking: <code className="text-accent">{data.scoring}</code></p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {data.suggestions.map((s: any) => (
          <li key={s.id} className="card">
            <div className="flex items-center justify-between">
              <p className="font-semibold">{s.display_name}</p>
              <span className="badge" aria-label={`score ${s.score}`}>score {s.score}</span>
            </div>
            <p className="text-xs text-slate-400">{s.timezone}</p>
            <p className="mt-2 flex flex-wrap gap-1">{(s.skills ?? []).map((x: string) => <span key={x} className="badge">{x}</span>)}</p>
            <dl className="mt-2 grid grid-cols-3 gap-1 text-xs text-slate-400">
              <div><dt>Complements you</dt><dd>{s.complementary_skills}</dd></div>
              <div><dt>Shared skills</dt><dd>{s.shared_skills}</dd></div>
              <div><dt>Timezone fit</dt><dd>{s.timezone_fit}</dd></div>
            </dl>
          </li>
        ))}
      </ul>
      {data.suggestions.length === 0 && <p className="text-slate-400">No suggestions yet - fill in your skills on your profile.</p>}
    </div>
  );
}
