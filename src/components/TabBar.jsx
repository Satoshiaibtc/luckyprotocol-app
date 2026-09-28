import { useApp } from "../context.js";

const ICON = {
  board: (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" />
      <rect x="13" y="3" width="8" height="8" />
      <rect x="3" y="13" width="8" height="8" />
      <rect x="13" y="13" width="8" height="8" />
    </svg>
  ),
  create: (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  ),
  market: (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="4" y="9" width="5" height="7" />
      <path d="M6.5 4v5M6.5 16v4" />
      <rect x="15" y="6" width="5" height="8" />
      <path d="M17.5 3v3M17.5 14v7" />
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M3 17l5-6 4 3 4-8 5 4" />
      <path d="M3 21h18" />
    </svg>
  ),
  me: (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="3" y="6" width="18" height="13" />
      <path d="M3 10h18M15 14h3" />
    </svg>
  ),
};

const ITEMS = [
  // No sixth tab (five 72px slots at 360px): the probability board lights
  // the Board tab and is reached from the block tape's "Probability →" link.
  { name: "board", href: "#/", label: "Board", match: ["board", "token", "notfound", "probability"] },
  { name: "market", href: "#/market", label: "Market", match: ["market"] },
  { name: "activity", href: "#/activity", label: "Activity", match: ["activity"] },
  { name: "create", href: "#/create", label: "Create", match: ["create"] },
  { name: "me", href: "#/me", label: "Portfolio", match: ["me", "send"] },
];

/** Phone-only bottom navigation: Board / Market / Activity / Create / Portfolio (fixed, safe-area aware). */
export default function TabBar() {
  const { route } = useApp();
  return (
    <nav className="tabbar" aria-label="Primary">
      {ITEMS.map((it) => {
        const active = it.match.includes(route.name);
        return (
          <a key={it.name} href={it.href} className={`tabbar-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined}>
            {ICON[it.name]}
            <span>{it.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
