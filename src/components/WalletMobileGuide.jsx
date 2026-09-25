import { useEffect, useState } from "react";
import { PROVIDER_META } from "../lib/walletShapes.js";

/** Current page URL (hash included, so the app's browser lands on this page). */
function siteUrl() {
  return typeof window !== "undefined" ? window.location.href : "";
}

async function copyText(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Shown on phones when no provider is injected: mobile browsers cannot run
 * an extension, so the way in is a wallet app's built-in browser (UniSat
 * app → Discover; OKX Wallet app → DApp browser). `action` = what
 * connecting unlocks ("mine", "create a token", …).
 */
export default function WalletMobileGuide({ action = "continue", extra = null }) {
  const [copied, setCopied] = useState(null); // null | "ok" | "fail"
  useEffect(() => {
    if (copied === null) return undefined;
    const id = setTimeout(() => setCopied(null), 2200);
    return () => clearTimeout(id);
  }, [copied]);

  const onCopy = async () => {
    setCopied((await copyText(siteUrl())) ? "ok" : "fail");
  };

  return (
    <div className="cta wallet-guide">
      <div>
        <strong>No wallet extension on phones.</strong> To {action}, open this site inside the UniSat app or the OKX Wallet app (Discover / DApp browser),
        then connect. LuckyProtocol never holds keys.
      </div>
      <div className="row">
        <button className="btn btn-primary btn-sm" type="button" onClick={onCopy} aria-live="polite">
          {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed — long-press the address bar" : "Copy site URL"}
        </button>
        <a className="btn btn-sm" href={PROVIDER_META.unisat.appUrl} target="_blank" rel="noopener noreferrer">
          Get the UniSat app
        </a>
        <a className="btn btn-sm" href={PROVIDER_META.okx.appUrl} target="_blank" rel="noopener noreferrer">
          Get the OKX Wallet app
        </a>
        {extra}
      </div>
      <div className="mono muted site-url" aria-label="Site URL">
        {siteUrl()}
      </div>
    </div>
  );
}
