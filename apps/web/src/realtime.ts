// Live updates: SSE from the API (Postgres LISTEN/NOTIFY) as the primary push
// channel, read with a fetch stream so the JWT travels in the Authorization
// header - never in the URL, access logs, or browser history. On every
// connect/reconnect the server sends a `sync` event and the client refetches,
// so changes missed during a disconnect are recovered by resync. A 60s poll
// remains as a safety net only. Without a token (signed out), 15s polling.

let sseActive = false;

export function subscribeBoardChanges(onChange: () => void, token: string | null): () => void {
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
  if (!token) {
    sseActive = false;
    const poll = setInterval(onChange, 15_000);
    return () => clearInterval(poll);
  }

  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ctrl: AbortController | undefined;
  let attempt = 0;

  async function connect() {
    if (closed) return;
    ctrl = new AbortController();
    try {
      const res = await fetch(`${apiUrl}/api/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      attempt = 0;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = frame.match(/^event: (.+)$/m)?.[1];
          if (ev === 'sync') { sseActive = true; onChange(); }
          else if (ev === 'change') onChange();
        }
      }
      throw new Error('stream ended');
    } catch {
      if (closed) return;
      sseActive = false;
      // Reconnect with capped backoff; the fresh `sync` on reconnect covers
      // anything missed while disconnected.
      const wait = Math.min(15_000, 500 * 2 ** attempt++);
      retry = setTimeout(connect, wait);
    }
  }
  void connect();

  const poll = setInterval(onChange, 60_000);
  return () => { closed = true; sseActive = false; clearInterval(poll); clearTimeout(retry); ctrl?.abort(); };
}

export const isRealtime = () => sseActive;
