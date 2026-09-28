/**
 * System-status LED. `state` ∈ idle | ok | busy | err. It reports the
 * health of a data source only — never an outcome (tier color lives on
 * DigitChip / tape tiles, not here).
 */
export default function Led({ state = "idle" }) {
  return <span className={`led${state !== "idle" ? ` led-${state}` : ""}`} aria-hidden="true" />;
}

/** Derive an LED state from a usePoll result. */
export function ledFromPoll(q) {
  if (!q) return "idle";
  if (q.error) return "err";
  if (q.loading && !q.data) return "busy";
  if (q.data) return "ok";
  return "idle";
}
