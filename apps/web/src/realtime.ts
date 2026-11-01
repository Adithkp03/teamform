// Live updates: SSE from the API as the primary channel, read with a fetch
// stream so the JWT travels in the Authorization header - never in the URL,
// access logs, or browser history. The server runs poll mode on serverless
// (near-real-time, ~1s) or LISTEN/NOTIFY push when self-hosted; the client is
// identical either way. Reconnects carry the last received event id in the
// `last-event-id` header so the server replays anything missed; on a fresh
// connect (or if the cursor was pruned) the server sends `sync` and the
// client refetches full state. A 60s poll remains as a safety net only.
// Without a token (signed out), 15s polling.

let sseActive = false;

import { getToken, refreshAccessToken } from './api';

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
  let lastId: string | null = null;
  let rotated = false;

  async function connect() {
    if (closed) return;
    ctrl = new AbortController();
    try {
      const liveToken = getToken() ?? token;
      const headers: Record<string, string> = { authorization: `Bearer ${liveToken}` };
      if (lastId) headers['last-event-id'] = lastId;
      let res = await fetch(`${apiUrl}/api/events`, { headers, signal: ctrl.signal });
      if (res.status === 401) {
        // Short-lived access token expired mid-rotation: refresh and retry once.
        const nt = await refreshAccessToken();
        if (nt) {
          headers.authorization = `Bearer ${nt}`;
          res = await fetch(`${apiUrl}/api/events`, { headers, signal: ctrl.signal });
        }
      }
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
          const id = frame.match(/^id: (.+)$/m)?.[1];
          if (id) lastId = id;
          if (ev === 'sync') { sseActive = true; onChange(); }
          else if (ev === 'change') onChange();
          else if (ev === 'rotate') rotated = true; // server asks for a fresh stream
        }
      }
      throw new Error('stream ended');
    } catch {
      if (closed) return;
      // Reconnect immediately after a server-requested rotation, with capped
      // backoff after real failures. The cursor (or a fresh `sync`) covers
      // anything missed while disconnected.
      sseActive = false;
      const wait = rotated ? 100 : Math.min(15_000, 500 * 2 ** attempt++);
      rotated = false;
      retry = setTimeout(connect, wait);
    }
  }
  void connect();

  const poll = setInterval(onChange, 60_000);
  return () => { closed = true; sseActive = false; clearInterval(poll); clearTimeout(retry); ctrl?.abort(); };
}

export const isRealtime = () => sseActive;
