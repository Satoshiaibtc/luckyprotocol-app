import { useEffect, useState } from "react";
import { copyText } from "../lib/clipboard.js";

/** Current page URL (hash included, so the app's browser lands on this page). */
export function siteUrl() {
  return typeof window !== "undefined" ? window.location.href : "";
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
