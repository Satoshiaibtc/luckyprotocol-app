import { useCallback, useEffect, useState } from "react";

// Lightweight hash router. Routes:
//   #/              board
//   #/t/<TICKER>    token page   (?tab=mine|buy|sell)
//   #/create        deploy form
//   #/me            portfolio
// Anything else → "notfound" (the shell renders the board with a notice).

const TICKER_RE = /^[A-Z0-9]{1,8}$/;

export function parseHash(hash) {
  let h = String(hash || "").replace(/^#/, "");
  if (!h.startsWith("/")) h = `/${h}`;
  const qi = h.indexOf("?");
  const pathPart = qi >= 0 ? h.slice(0, qi) : h;
  const queryPart = qi >= 0 ? h.slice(qi + 1) : "";
  const params = {};
  for (const [k, v] of new URLSearchParams(queryPart)) params[k] = v;
  const segs = pathPart
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
  const base = { path: pathPart, params };
  if (segs.length === 0) return { ...base, name: "board" };
  if (segs[0] === "t" && segs.length === 2) {
    const ticker = segs[1].toUpperCase();
    return TICKER_RE.test(ticker) ? { ...base, name: "token", ticker } : { ...base, name: "notfound" };
  }
  if (segs[0] === "create" && segs.length === 1) return { ...base, name: "create" };
  if (segs[0] === "me" && segs.length === 1) return { ...base, name: "me" };
  return { ...base, name: "notfound" };
}

export function tokenHref(ticker, tab) {
  return `#/t/${encodeURIComponent(String(ticker).toUpperCase())}${tab ? `?tab=${tab}` : ""}`;
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(typeof window !== "undefined" ? window.location.hash : ""));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // New page → scroll to top (tab switches within a page don't count).
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route.name, route.ticker]);

  const navigate = useCallback((to, { replace = false } = {}) => {
    const target = to.startsWith("#") ? to : `#${to}`;
    if (replace) {
      const url = `${window.location.pathname}${window.location.search}${target}`;
      window.history.replaceState(null, "", url);
      setRoute(parseHash(target));
    } else {
      window.location.hash = target;
    }
  }, []);

  return { route, navigate };
}
