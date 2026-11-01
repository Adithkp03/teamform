/**
 * Short-TTL in-process cache for the public board payload (GET /api/board).
 *
 * Why it is safe:
 * - Authorization runs in the route's preHandler BEFORE the cache is read;
 *   the cache only stores the data payload, never per-user state.
 * - The board payload is identical for every authenticated user (no
 *   user-specific fields), so cross-user serving leaks nothing the endpoint
 *   would not already return.
 * - Key scope: the `limit` query parameter only (the board is
 *   hackathon-wide today; if a hackathon filter is added it joins the key).
 * - Freshness: same-instance mutations invalidate synchronously AFTER the
 *   response commit (onResponse hook, 2xx only - a rolled-back transaction
 *   never invalidates). Cross-instance staleness is bounded by the TTL
 *   (1s), matching the already-disclosed ~1s poll-mode realtime latency.
 *   The bound does NOT depend on any SSE listener being connected.
 * - Memory: bounded at MAX_ENTRIES entries (insertion-order eviction).
 */
const TTL_MS = 1000;
const MAX_ENTRIES = 32;

const cache = new Map<number, { at: number; body: unknown }>();

export function cachedBoard(limit: number): unknown | null {
  const hit = cache.get(limit);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body;
  return null;
}

export function storeBoard(limit: number, body: unknown): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(limit)) {
    const oldest = cache.keys().next().value as number;
    cache.delete(oldest);
  }
  cache.set(limit, { at: Date.now(), body });
}

export function invalidateBoard(): void {
  cache.clear();
}

/** Test/introspection only. */
export function boardCacheSize(): number {
  return cache.size;
}

export const BOARD_CACHE_TTL_MS = TTL_MS;
