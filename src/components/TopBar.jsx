import { useState } from "react";
import { useApp } from "../context.js";
import { fmtInt, shortAddr, walletBalanceText } from "../lib/format.js";
import { chipLabel } from "../lib/walletShapes.js";
import { chainTipOf } from "../lib/sync.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { useIsMobile } from "../hooks/useMediaQuery.js";
import Led from "./hud/Led.jsx";

const NAV = [
  { name: "board", href: "#/", label: "Board" },
  { name: "market", href: "#/market", label: "Market" },
  { name: "activity", href: "#/activity", label: "Activity" },
  { name: "create", href: "#/create", label: "Create" },
  { name: "probability", href: "#/probability", label: "Probability" },
  { name: "me", href: "#/me", label: "Portfolio" },
];

/**
 * Desktop: wordmark · search · nav · [mock] SYS pill · wallet.
 * Phone (≤ 720px): ONE 56px row — wordmark · compact SYS chip · wallet; the
 * search and nav move to the board filter and the bottom tab bar. The
 * wallet control is the same on both: one "Connect Wallet" button (→ the
 * wallet dialog) or, once connected, the provider · address chip (→ the
 * same dialog with Switch wallet / Disconnect).
 */
export default function TopBar() {
  const { wallet, health, sync, mock, openWalletModal, route, navigate, tokens } = useApp();
  const mobile = useIsMobile();
  const [q, setQ] = useState("");

  const h = health.data;
  let pillClass = "pill";
  let led = "busy";
  let pillText = <>SYS · connecting…</>;
  let compactText = <>…</>;
  if (health.error) {
    pillClass += " pill-danger";
    led = "err";
    pillText = <>SYS · offline</>;
    compactText = <>offline</>;
  } else if (h) {
    const height = <span className="num">#{fmtInt(chainTipOf(h))}</span>;
    compactText = height;
    if (h.stalled) {
      pillClass += " pill-warn";
      led = "busy";
      pillText = <>SYS · {height} · {sync.noPeers ? "no peers" : "stalled"}</>;
    } else if (sync.rebuilding) {
      pillClass += " pill-warn";
      led = "busy";
      pillText = <>SYS · {height} · rebuilding</>;
    } else if (sync.networkLag > 0) {
      // The node's own tip trails an independent one (src/lib/network.js).
      pillClass += " pill-warn";
      led = "busy";
      pillText = (
        <>
          SYS · {height} · behind network<span className="num"> −{fmtInt(sync.networkLag)}</span>
        </>
      );
    } else if (!sync.synced) {
      // "synced" is said only when the indexer has applied the tip block —
      // during a cold scan it can be thousands behind.
      pillClass += " pill-warn";
      led = "busy";
      pillText = (
        <>
          SYS · {height} · syncing{sync.lag ? <span className="num"> −{fmtInt(sync.lag)}</span> : null}
        </>
      );
    } else if (sync.noPeers) {
      pillClass += " pill-warn";
      led = "busy";
      pillText = <>SYS · {height} · no peers</>;
    } else {
      pillClass += " pill-ok";
      led = "ok";
      pillText = <>SYS · {height} · synced</>;
    }
  }
  const syncWord = syncWordOf(h, sync);
  const pillTitle = health.error
    ? String(health.error.message)
    : `indexer ${h?.network || ""} · block height${syncWord ? ` · ${syncWord}` : ""}${mock ? " · VITE_MOCK=1 (fake indexer)" : ""}`;

  const submit = (e) => {
    e.preventDefault();
    const t = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!t) return;
    setQ("");
    navigate(tokenHref(t));
  };

  const tickers = tokens.data?.items?.map((t) => t.ticker) || [];

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="wordmark" href="#/" aria-label="LuckyProtocol home">
          <span className="mark chamfer" aria-hidden="true" />
          <span>
            LUCKY<span className="slash">//</span>
            <span className="accent">PROTOCOL</span>
          </span>
        </a>

        {!mobile && (
          <form className="search" role="search" onSubmit={submit}>
            <input
              className="search-input mono"
              type="search"
              list="ticker-list"
              placeholder="Search ticker"
              aria-label="Search ticker"
              value={q}
              onChange={(e) => setQ(e.target.value.toUpperCase())}
              maxLength={8}
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id="ticker-list">
              {tickers.map((t) => (
                <option value={t} key={t} />
              ))}
            </datalist>
          </form>
        )}

        {!mobile && (
          <nav className="nav" aria-label="Primary">
            {NAV.map((n) => {
              // the Send page is part of the portfolio
              const on = route.name === n.name || (n.name === "me" && route.name === "send");
              return (
                <a key={n.name} href={n.href} className={`nav-link${on ? " active" : ""}`} aria-current={on ? "page" : undefined}>
                  {n.label}
                </a>
              );
            })}
          </nav>
        )}

        <div className="topbar-right">
          {mock && !mobile && (
            <span className="pill pill-warn" title="VITE_MOCK=1 — deterministic fake indexer">
              <Led state="busy" />
              mock
            </span>
          )}
          <span className={pillClass} title={pillTitle} aria-label={mobile ? `System: ${h ? `block #${fmtInt(chainTipOf(h))}${syncWord ? `, ${syncWord}` : ""}` : health.error ? "offline" : "connecting"}` : undefined}>
            <Led state={led} />
            {mobile ? compactText : pillText}
          </span>
          <WalletControl wallet={wallet} mobile={mobile} onOpen={openWalletModal} />
        </div>
      </div>
    </header>
  );
}

/** The pill's title word for the indexer's state ("" before the first answer). */
function syncWordOf(h, sync) {
  if (!h) return "";
  if (h.stalled) return sync.noPeers ? "stalled — the node has no peers" : "stalled";
  if (sync.rebuilding) return "rebuilding";
  if (sync.networkLag > 0) return `our node is ${fmtInt(sync.networkLag)} blocks behind the network`;
  if (!sync.synced) return sync.lag !== null ? `syncing — indexed #${fmtInt(sync.indexed)} of #${fmtInt(sync.tip)}` : "syncing";
  return sync.noPeers ? "synced, but the node has no peers" : "synced";
}

/**
 * ONE control on every layout: "Connect Wallet" (opens the wallet dialog)
 * until a session exists, then the "OKX · bc1p…" chip, which opens the same
 * dialog with Switch wallet / Disconnect.
 */
function WalletControl({ wallet, mobile, onOpen }) {
  switch (wallet.status) {
    case "connecting":
      return (
        <button className="btn btn-primary btn-sm" disabled type="button" aria-busy="true">
          Connecting…
        </button>
      );
    case "connected": {
      const title = `${wallet.providerName || "Wallet"} · ${wallet.address} — switch or disconnect`;
      return (
        <button className="wallet-addr" type="button" onClick={onOpen} title={title} aria-label={`${wallet.providerName || "Wallet"} ${wallet.address} — open wallet options`} aria-haspopup="dialog">
          {mobile && <Led state="ok" />}
          <span>{chipLabel(wallet.provider, shortAddr(wallet.address, mobile ? 4 : 5, mobile ? 3 : 4))}</span>
          {!mobile && <span className="bal">{wallet.balance !== null ? walletBalanceText(wallet.balance, wallet.balanceConfirmed, { short: true }) : "…"}</span>}
        </button>
      );
    }
    default:
      // detecting | absent | disconnected: the dialog explains what is (not) installed.
      return (
        <button className="btn btn-primary btn-sm" type="button" onClick={onOpen} disabled={wallet.status === "detecting"} aria-haspopup="dialog">
          Connect Wallet
        </button>
      );
  }
}
