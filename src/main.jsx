import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Self-hosted fonts (no CDN — CSP font-src 'self').
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/jetbrains-mono/300.css"; // light display numerals
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/chakra-petch/700.css";

import "./styles.css";
import App from "./App.jsx";
import { canonicalRedirectTarget, hashRouteForPath } from "./lib/canonicalHost.js";

// A path-style link (/t/LUCKY) becomes its hash route (/#/t/LUCKY) before
// anything renders — the router reads only the hash.
const pathFix = hashRouteForPath({ pathname: location.pathname, search: location.search, hash: location.hash });
const fixed = pathFix ? new URL(pathFix, location.origin) : location;

// Canonical host: the default *.pages.dev origin has its own
// localStorage, so the pending-carrier registry written there is invisible
// on the real host (and vice versa). Send such visits to the canonical
// origin with the same path + hash before anything renders. Dev / mock are
// exempt.
const redirect = canonicalRedirectTarget({
  hostname: location.hostname,
  pathname: fixed.pathname,
  search: fixed.search,
  hash: fixed.hash,
  dev: import.meta.env.DEV,
  mock: import.meta.env.VITE_MOCK === "1",
});
if (redirect) location.replace(redirect);
// Same origin: rewrite the URL in place (no reload) — the router reads the hash on mount.
else if (pathFix) history.replaceState(null, "", pathFix);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
