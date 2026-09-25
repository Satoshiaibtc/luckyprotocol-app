import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context.js";
import { fmtBtc, shortAddr } from "../lib/format.js";
import { isMobileBrowser } from "../lib/wallet.js";
import { PROVIDER_IDS, PROVIDER_META } from "../lib/walletShapes.js";
import Led from "./hud/Led.jsx";
import WalletMobileGuide from "./WalletMobileGuide.jsx";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The ONE wallet dialog (desktop and phones): opened by the top bar's
 * "Connect Wallet" button / connected chip and by every ConnectPrompt.
 *
 *   disconnected  → provider cards: Installed → Connect · Not installed →
 *                   Install (desktop) / "open in the app" guidance + copy-URL
 *                   (phones) · simulated wallet in mock mode
 *   connected     → the current session (provider · address · balance) with
 *                   Disconnect, then the same cards under "Switch wallet"
 *
 * Accessible: role=dialog + aria-modal, labelled by its heading, focus
 * moves in on open and back to the opener on close, Tab / Shift+Tab cycle
 * inside, Esc and the backdrop close it. Body scroll is locked while open.
 */
export default function WalletModal() {
  const { wallet, mock, connect, disconnect, useMock: enableSimulated, walletModalOpen: open, closeWalletModal: onClose } = useApp();
  const [pendingId, setPendingId] = useState(null);
  const dialogRef = useRef(null);

  const phone = isMobileBrowser();
  const connected = wallet.status === "connected";
  const detecting = wallet.status === "detecting";
  const busy = wallet.status === "connecting";
  const present = new Set((wallet.providers || []).filter((p) => p.present).map((p) => p.id));

  // Focus management + Esc + scroll lock.
  useEffect(() => {
    if (!open) return undefined;
    const node = dialogRef.current;
    if (!node) return undefined;
    const opener = typeof document !== "undefined" ? document.activeElement : null;
    const focusables = () => Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    const first = focusables().find((el) => !el.classList.contains("modal-close")) || focusables()[0];
    (first || node).focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const head = f[0];
      const tail = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === head || !node.contains(active))) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (active === tail || !node.contains(active))) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, onClose]);

  const pick = useCallback(
    async (id) => {
      setPendingId(id);
      const ok = id === "mock" ? await enableSimulated() : await connect(id);
      setPendingId(null);
      if (ok) onClose();
    },
    [connect, enableSimulated, onClose],
  );

  if (!open) return null;

  const cards = PROVIDER_IDS.map((id) => {
    const meta = PROVIDER_META[id];
    const installed = present.has(id);
    const current = connected && wallet.provider === id;
    return (
      <li key={id} className={`wallet-card${installed ? " installed" : ""}${current ? " current" : ""}`}>
        <div className="wallet-card-head">
          <span className="wallet-card-name">{meta.name}</span>
          <span className={`status-tag${current ? " s-open" : installed ? " s-ok" : ""}`}>
            {current ? "Connected" : installed ? "Installed" : detecting ? "Detecting…" : phone ? "Not detected" : "Not installed"}
          </span>
        </div>
        <p className="wallet-card-desc">{meta.description}</p>
        {!installed && !detecting && phone && <p className="wallet-card-hint">{meta.mobileHint}</p>}
        <div className="wallet-card-action">
          {current ? (
            <button className="btn btn-sm" type="button" disabled>
              Connected
            </button>
          ) : installed ? (
            <button className="btn btn-primary btn-sm" type="button" onClick={() => pick(id)} disabled={busy || detecting} aria-label={`Connect ${meta.name}`}>
              {busy && pendingId === id ? "Connecting…" : connected ? `Switch to ${meta.short}` : "Connect"}
            </button>
          ) : phone ? (
            <a className="btn btn-sm" href={meta.appUrl} target="_blank" rel="noopener noreferrer">
              Get the {meta.name} app
            </a>
          ) : (
            <a className="btn btn-primary btn-sm" href={meta.installUrl} target="_blank" rel="noopener noreferrer" aria-label={`Install ${meta.name}`}>
              Install
            </a>
          )}
        </div>
      </li>
    );
  });

  if (mock) {
    const meta = PROVIDER_META.mock;
    const current = connected && wallet.provider === "mock";
    cards.push(
      <li key="mock" className={`wallet-card installed${current ? " current" : ""}`}>
        <div className="wallet-card-head">
          <span className="wallet-card-name">{meta.name}</span>
          <span className={`status-tag${current ? " s-open" : ""}`}>{current ? "Connected" : "Mock mode"}</span>
        </div>
        <p className="wallet-card-desc">{meta.description}</p>
        <div className="wallet-card-action">
          <button className={`btn btn-sm${current ? "" : " btn-primary"}`} type="button" onClick={() => pick("mock")} disabled={current || busy}>
            {current ? "Connected" : busy && pendingId === "mock" ? "Connecting…" : connected ? "Switch to simulated" : "Use simulated wallet"}
          </button>
        </div>
      </li>,
    );
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-modal-title" ref={dialogRef} tabIndex={-1}>
        <div className="modal-head">
          <h2 id="wallet-modal-title">{connected ? "Wallet" : "Connect Wallet"}</h2>
          <button className="btn btn-ghost btn-sm modal-close" type="button" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        {connected ? (
          <div className="wallet-current" aria-label="Connected wallet">
            <Led state="ok" />
            <span className="wallet-current-name">{wallet.providerName}</span>
            <span className="mono" title={wallet.address}>
              {shortAddr(wallet.address, 8, 6)}
            </span>
            <span className="muted">{wallet.balance !== null ? `${fmtBtc(wallet.balance)} BTC` : ""}</span>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                disconnect();
                onClose();
              }}
              aria-label="Disconnect wallet"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <p className="wallet-modal-lead">
            Pick a Bitcoin wallet. LuckyProtocol never holds keys — every transaction is signed in your wallet, on Bitcoin mainnet only.
          </p>
        )}

        {connected && <span className="label wallet-modal-sub">Switch wallet</span>}
        <ul className="wallet-cards" aria-label={connected ? "Switch wallet" : "Wallets"}>
          {cards}
        </ul>

        {phone && present.size === 0 && !detecting && <WalletMobileGuide />}

        {wallet.error && (
          <div className="err" role="alert">
            {wallet.error}
          </div>
        )}
      </div>
    </div>
  );
}
