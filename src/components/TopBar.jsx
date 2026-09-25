import { useState } from "react";
import { useApp } from "../context.js";
import { blockUrl, fmtBtc, fmtInt, shortAddr, UNISAT_INSTALL_URL } from "../lib/format.js";
import { tokenHref } from "../hooks/useHashRoute.js";
import { bucketOfHash, yieldDigit } from "../lib/yield.js";
import Led from "./hud/Led.jsx";
import DigitChip from "./DigitChip.jsx";

const NAV = [
  { name: "board", href: "#/", label: "Board" },
  { name: "create", href: "#/create", label: "Create" },
  { name: "me", href: "#/me", label: "Portfolio" },
];

export default function TopBar() {
  const { wallet, health, mock, connect, disconnect, useMock, route, navigate, tokens, tipBlock } = useApp();
  const [q, setQ] = useState("");

  const h = health.data;
  let pillClass = "pill";
  let led = "busy";
  let pillText = <>SYS · connecting…</>;
  if (health.error) {
    pillClass += " pill-danger";
    led = "err";
    pillText = <>SYS · offline</>;
  } else if (h) {
    const height = <span className="num">#{fmtInt(h.tip_height)}</span>;
    if (h.stalled) {
      pillClass += " pill-warn";
      led = "busy";
      pillText = <>SYS · {height} · stalled</>;
    } else {
      pillClass += " pill-ok";
      led = "ok";
      pillText = <>SYS · {height} · synced</>;
    }
  }

  const submit = (e) => {
    e.preventDefault();
    const t = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!t) return;
    setQ("");
    navigate(tokenHref(t));
  };

  const tickers = tokens.data?.items?.map((t) => t.ticker) || [];
  const tipHash = tipBlock?.data?.hash || null;
  const tipBucket = tipHash ? bucketOfHash(tipHash) : null;

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

        <nav className="nav" aria-label="Primary">
          {NAV.map((n) => (
            <a key={n.name} href={n.href} className={`nav-link${route.name === n.name ? " active" : ""}`} aria-current={route.name === n.name ? "page" : undefined}>
              {n.label}
            </a>
          ))}
        </nav>

        <div className="topbar-right">
          {mock && (
            <span className="pill pill-warn" title="VITE_MOCK=1 — deterministic fake indexer">
              <Led state="busy" />
              mock
            </span>
          )}
          <span className={pillClass} title={health.error ? String(health.error.message) : `indexer ${h?.network || ""} · block height`}>
            <Led state={led} />
            {pillText}
          </span>
          {tipHash && tipBucket && (
            <a
              className="tip-chip"
              href={blockUrl(tipBlock.data.height)}
              target="_blank"
              rel="noopener noreferrer"
              title={`Latest block #${fmtInt(tipBlock.data.height)} · last digit ${yieldDigit(tipHash)} → ${tipBucket.yield} per mine`}
            >
              <DigitChip digit={yieldDigit(tipHash)} size="sm" />
            </a>
          )}
          <WalletControl wallet={wallet} mock={mock} onConnect={connect} onDisconnect={disconnect} onUseMock={useMock} />
        </div>
      </div>
    </header>
  );
}

function WalletControl({ wallet, mock, onConnect, onDisconnect, onUseMock }) {
  switch (wallet.status) {
    case "detecting":
      return <span className="pill">detecting UniSat…</span>;
    case "absent":
      return (
        <div className="wallet">
          <a className="btn btn-primary btn-sm" href={UNISAT_INSTALL_URL} target="_blank" rel="noopener noreferrer">
            Install UniSat
          </a>
          {mock && (
            <button className="btn btn-sm" onClick={onUseMock} type="button">
              Use simulated wallet
            </button>
          )}
        </div>
      );
    case "connecting":
      return (
        <button className="btn btn-primary btn-sm" disabled type="button">
          Connecting…
        </button>
      );
    case "connected":
      return (
        <div className="wallet">
          <a className="wallet-addr" href="#/me" title={wallet.address}>
            <span>{shortAddr(wallet.address, 5, 4)}</span>
            <span className="bal">{wallet.balance !== null ? `${fmtBtc(wallet.balance)} BTC` : "…"}</span>
          </a>
          <button className="btn btn-ghost btn-sm" onClick={onDisconnect} type="button" aria-label="Disconnect wallet">
            Disconnect
          </button>
        </div>
      );
    default:
      return (
        <div className="wallet">
          <button className="btn btn-primary btn-sm" onClick={onConnect} type="button">
            Connect UniSat
          </button>
          {mock && (
            <button className="btn btn-sm" onClick={onUseMock} type="button">
              Simulated wallet
            </button>
          )}
        </div>
      );
  }
}
