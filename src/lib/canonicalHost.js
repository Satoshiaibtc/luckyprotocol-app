// Canonical host (audit L-15). Cloudflare Pages also serves the app from
// its default *.pages.dev origin. localStorage and wallet connections are
// per origin, so the pending-carrier registry (src/lib/pending.js) written
// on one host is invisible on the other — a just-created token carrier
// could then be picked as a fee input there. main.jsx redirects every
// *.pages.dev visit to the canonical host before rendering; dev and mock
// builds are exempt.

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

/**
 * A path-style link to a hash route (audit visit-8): Pages serves
 * index.html for ANY path, so /t/LUCKY rendered the board with no notice
 * and every later link carried the bogus path (/t/LUCKY#/market). Returns
 * the URL to replace the current one with, or null when the path is the
 * root or names a file (anything with an extension).
 *
 *   /t/LUCKY            → /#/t/LUCKY
 *   /t/LUCKY?tab=market → /#/t/LUCKY?tab=market
 *   /market/            → /#/market
 *   /t/LUCKY#/activity  → /#/activity   (an explicit hash route wins)
 */
export function hashRouteForPath({ pathname = "/", search = "", hash = "" } = {}) {
  const path = String(pathname || "/");
  if (path === "/" || path === "") return null;
  const last = path.split("/").filter(Boolean).pop() || "";
  if (/\.[A-Za-z0-9]+$/.test(last)) return null;
  const h = String(hash || "");
  if (h.length > 1 && h !== "#/") return `/${h}`;
  const route = path.replace(/\/+$/, "") || "/";
  return `/#${route}${search || ""}`;
}
