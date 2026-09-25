// VITE_SPEC_URL validation (audit L-16): the footer's "Protocol spec" link
// target comes from a build-time env value. Like VITE_INDEXER_URL it is
// validated before it can become an href — an https URL, or an absolute
// same-origin path — and anything else falls back to the copy served
// from public/. Pure and window-free (test/web.test.js).

export const DEFAULT_SPEC_URL = "/PROTOCOL-v3.md";

export function isAllowedSpecUrl(url) {
  if (typeof url !== "string") return false;
  const s = url.trim();
  if (!s || /\s/.test(s)) return false;
  // Absolute same-origin path: "/x", never "//host" (protocol-relative).
  if (s.startsWith("/")) return !s.startsWith("//");
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname.length > 0;
}

/** The href to use for the spec link: the configured value if allowed, else DEFAULT_SPEC_URL. */
export function resolveSpecUrl(configured) {
  const s = String(configured || "").trim();
  return s && isAllowedSpecUrl(s) ? s : DEFAULT_SPEC_URL;
}
