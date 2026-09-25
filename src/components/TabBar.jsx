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
  me: (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="3" y="6" width="18" height="13" />
      <path d="M3 10h18M15 14h3" />
    </svg>
  ),
};

const ITEMS = [
  { name: "board", href: "#/", label: "Board", match: ["board", "token", "notfound"] },
  { name: "create", href: "#/create", label: "Create", match: ["create"] },
  { name: "me", href: "#/me", label: "Portfolio", match: ["me"] },
];

/** Phone-only bottom navigation: Board / Create / Portfolio (fixed, safe-area aware). */
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
