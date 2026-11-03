// Probability gate for the background self-prune hooks (rate-limit buckets,
// idempotency keys, metrics rollup flush). SELF_PRUNE_PROB is a TEST-ONLY
// override - production never sets it, so the per-hook default applies.
// An unset, non-numeric, NaN, or out-of-[0,1] value falls back to the
// default: a malformed value must never silently disable pruning in prod.
export function selfPruneProb(def: number): number {
  const raw = process.env.SELF_PRUNE_PROB;
  if (raw === undefined || raw.trim() === '') return def; // Number('') is 0
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) return def;
  return v;
}
