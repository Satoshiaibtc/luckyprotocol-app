import { useCallback, useSyncExternalStore } from "react";

/** The one phone breakpoint. CSS uses the same value in `@media (max-width: 720px)`. */
export const MOBILE_QUERY = "(max-width: 720px)";

/**
 * `useMediaQuery(query, fallback = false)` → boolean, live via matchMedia.
 * SSR / no-matchMedia environments return `fallback` and never subscribe.
 */
export function useMediaQuery(query, fallback = false) {
  const subscribe = useCallback(
    (onChange) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(query);
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      mql.addListener(onChange); // Safari < 14
      return () => mql.removeListener(onChange);
    },
    [query],
  );
  const getSnapshot = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback);
  const getServerSnapshot = () => fallback;
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** `true` at phone widths (≤ 720px). */
export function useIsMobile() {
  return useMediaQuery(MOBILE_QUERY);
}
