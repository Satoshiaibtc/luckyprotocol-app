// Canonical host (audit L-15). Cloudflare Pages also serves the app from
// its default *.pages.dev origin. localStorage is per origin, so an avatar
// recovery record written on one host is invisible on the other — a user
// could pay a commit twice. main.jsx redirects every *.pages.dev visit to
// the canonical host before rendering; dev and mock builds are exempt.

export const CANONICAL_HOST = "app.luckyprotocolai.com";

/**
 * The URL to redirect to, or null when the page should render here.
 * Pure: `{ hostname, pathname, search, hash }` from `location`, plus
 * `dev` (import.meta.env.DEV) and `mock` (VITE_MOCK === "1").
 */
export function canonicalRedirectTarget({ hostname, pathname = "/", search = "", hash = "", dev = false, mock = false }) {
  if (dev || mock) return null;
  const host = String(hostname || "").toLowerCase();
  if (!host.endsWith(".pages.dev")) return null;
  return `https://${CANONICAL_HOST}${pathname || "/"}${search || ""}${hash || ""}`;
}
