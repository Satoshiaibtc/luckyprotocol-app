import { useEffect, useState } from "react";

/** Current page URL (hash included, so the app's browser lands on this page). */
export function siteUrl() {
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

/** "Copy site URL" with a 2.2 s "Copied" / "Copy failed" echo. */
export function CopySiteUrlButton({ className = "btn btn-primary btn-sm" }) {
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
    <button className={className} type="button" onClick={onCopy} aria-live="polite">
      {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed — long-press the address bar" : "Copy site URL"}
    </button>
  );
}

/**
 * Shown (inside the wallet modal) on phones when no provider is injected:
 * mobile browsers cannot run an extension, so the way in is a wallet app's
 * built-in browser (UniSat app → Discover; OKX Wallet app → DApp browser).
 * The per-wallet "Get the app" links live on the provider cards above it;
 * this block carries the copy-URL affordance and the URL itself.
 */
export default function WalletMobileGuide({ extra = null }) {
  return (
    <div className="wallet-guide">
      <div>
        <strong>No wallet extension on phones.</strong> Copy this page&apos;s address, open it inside the UniSat app or the OKX Wallet app (Discover / DApp browser),
        and tap Connect Wallet there. LuckyProtocol never holds keys.
      </div>
      <div className="row">
        <CopySiteUrlButton />
        {extra}
      </div>
      <div className="mono muted site-url" aria-label="Site URL">
        {siteUrl()}
      </div>
    </div>
  );
}
