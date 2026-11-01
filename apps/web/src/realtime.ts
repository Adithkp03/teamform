// Live updates: Supabase Realtime (postgres_changes) when configured, otherwise
// a 15s poll fallback so the board is never stale. Subscribers get poked to refetch.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient | null = null;
let realtimeActive = false;

export function subscribeBoardChanges(onChange: () => void, token: string | null): () => void {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

  if (url && anon && token) {
    if (!supabase) {
      supabase = createClient(url, anon, {
        auth: { persistSession: false, autoRefreshToken: false },
        accessToken: async () => token,
      });
    }
    const channel = supabase
      .channel('teamform-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_members' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'join_requests' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, onChange)
      .subscribe((status) => { realtimeActive = status === 'SUBSCRIBED'; });
    // Missed-event safety net: even with realtime, refetch every 60s. A dropped
    // socket reconnects, but a change during the gap would otherwise be missed.
    const poll = setInterval(onChange, 60_000);
    return () => { clearInterval(poll); supabase?.removeChannel(channel); };
  }

  realtimeActive = false;
  const poll = setInterval(onChange, 15_000);
  return () => clearInterval(poll);
}

export const isRealtime = () => realtimeActive;
