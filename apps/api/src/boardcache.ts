/**
 * Short-TTL in-process cache for the public board payload (GET /api/board).
 *
 * Why it is safe:
 * - Authorization runs in the route's preHandler BEFORE the cache is read;
 *   the cache only stores the data payload, never per-user state.
 * - The board payload is identical for every authenticated user (no
 *   user-specific fields), so cross-user serving leaks nothing the endpoint
 *   would not already return.
 * - Key scope: the `limit` query parameter plus both pagination cursors
 *   (the board is hackathon-wide today; if a hackathon filter is added it
 *   joins the key).
 * - Freshness: same-instance mutations invalidate synchronously AFTER the
 *   commit, before response bytes (onSend hook, 2xx only - a rolled-back transaction
 *   never invalidates). Cross-instance staleness is bounded by the TTL
 *   (1s), matching the already-disclosed ~1s poll-mode realtime latency.
 *   The bound does NOT depend on any SSE listener being connected.
 * - Memory: bounded at MAX_ENTRIES entries (insertion-order eviction).
 */
const TTL_MS = 1000;
const MAX_ENTRIES = 32;

const cache = new Map<string, { at: number; body: unknown }>();
// Generation guard for the read/mutation race: a read that MISSED may be
// in flight while a mutation commits and invalidates. Without a version,
// that read would repopulate the cache with the pre-mutation snapshot and
// serve it for a full TTL. storeBoard only applies if the generation has
// not advanced since the read started.
let generation = 0;

export function boardGeneration(): number {
  return generation;
}

export function cachedBoard(key: string): unknown | null {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body;
  return null;
}

export function storeBoard(key: string, body: unknown, readGen: number): void {
  if (readGen !== generation) return; // a mutation landed while we read
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), body });
}

export function invalidateBoard(): void {
  generation++;
  cache.clear();
  pending.clear();
}

/** Test/introspection only. */
export function boardCacheSize(): number {
  return cache.size;
}

export const BOARD_CACHE_TTL_MS = TTL_MS;

// Deduplicate only reads of the same key in the same cache generation.
// Clearing on invalidation keeps later reads from joining an older snapshot.
const pending = new Map<string, Promise<unknown>>();
export async function readBoard(key: string, load: () => Promise<unknown>): Promise<unknown> {
  const hit = cachedBoard(key);
  if (hit) return hit;
  const existing = pending.get(key);
  if (existing) return existing;
  const gen = generation;
  const task = Promise.resolve().then(load).then((body) => {
    storeBoard(key, body, gen);
    return body;
  });
  // Bound in-flight bookkeeping without canceling already-started reads.
  if (pending.size >= MAX_ENTRIES) pending.delete(pending.keys().next().value as string);
  pending.set(key, task);
  try { return await task; }
  finally { if (pending.get(key) === task) pending.delete(key); }
}
export function boardPendingSize(): number { return pending.size; }
