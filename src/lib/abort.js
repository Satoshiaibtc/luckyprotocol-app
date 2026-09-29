// Stopped reads — pure, no React, tested in plain Node (test/poll.test.js).

/** True for a stopped read (the flow was left, or the wallet changed while it read). */
export function isAbortError(e) {
  return !!e && e.name === "AbortError";
}

/** The error a stopped read ends with. */
export function abortError(what = "Stopped.") {
  return Object.assign(new Error(what), { name: "AbortError" });
}
