import { fmtBtc, fmtInt, shortAddr, UNISAT_INSTALL_URL } from "../lib/format.js";

export default function TopBar({ wallet, health, mock, onConnect, onDisconnect, onUseMock }) {
  const h = health.data;
  let pillClass = "pill";
  let pillText = "connecting…";
  if (health.error) {
    pillClass += " pill-danger";
    pillText = "indexer offline";
  } else if (h) {
    if (h.stalled) {
      pillClass += " pill-warn";
      pillText = `${h.network} · stalled`;
    } else {
      pillClass += " pill-ok";
      pillText = `${h.network} · #${fmtInt(h.tip_height)}`;
    }
  }

  return (
    <header className="topbar">
      <div className="wordmark" aria-label="LuckyProtocol">
        <span className="mark" aria-hidden="true" />
        LUCKY<span className="accent">PROTOCOL</span>
      </div>

      <div className="topbar-right">
        {mock && (
          <span className="pill pill-warn" title="VITE_MOCK=1 — deterministic fake indexer">
            <span className="dot" aria-hidden="true" />
            mock
          </span>
        )}
        <span className={pillClass} title={health.error ? String(health.error.message) : "indexer status"}>
          <span className="dot" aria-hidden="true" />
          {pillText}
        </span>

        <WalletControl
          wallet={wallet}
          mock={mock}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onUseMock={onUseMock}
        />
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
          <span className="wallet-addr" title={wallet.address}>
            <span>{shortAddr(wallet.address)}</span>
            <span className="bal">{wallet.balance !== null ? `${fmtBtc(wallet.balance)} BTC` : "…"}</span>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onDisconnect} type="button">
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
