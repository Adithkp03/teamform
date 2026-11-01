// Live updates: SSE from the API (Postgres LISTEN/NOTIFY) as the primary push
// channel. On every connect/reconnect the server sends a `sync` event and the
// client refetches, so changes missed during a disconnect are recovered by
// resync. A 60s poll remains as a safety net only. If no API URL is
// configured (pure static demo), fall back to 15s polling.

let sseActive = false;

export function subscribeBoardChanges(onChange: () => void, token: string | null): () => void {
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

  if (token) {
    const es = new EventSource(`${apiUrl}/api/events?token=${encodeURIComponent(token)}`);
    es.addEventListener('sync', () => { sseActive = true; onChange(); });
    es.addEventListener('change', onChange);
    // EventSource reconnects automatically after errors; the reconnect gets a
    // fresh `sync` event, which triggers a refetch - missed events covered.
    const poll = setInterval(onChange, 60_000);
    return () => { clearInterval(poll); es.close(); sseActive = false; };
  }

  sseActive = false;
  const poll = setInterval(onChange, 15_000);
  return () => clearInterval(poll);
}

export const isRealtime = () => sseActive;
