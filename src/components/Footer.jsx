import { useEffect, useState } from "react";
import { isAllowedSpecUrl, resolveSpecUrl } from "../lib/specUrl.js";
import { PROJECT_FEE_ADDRESS } from "../lib/payloads.js";
import { copyText } from "../lib/clipboard.js";

// VITE_SPEC_URL is validated like VITE_INDEXER_URL before it can become an
// href (https, or an absolute same-origin path); anything else falls back
// to the copy served from public/.
const _configuredSpec = String(import.meta.env.VITE_SPEC_URL || "").trim();
const SPEC_URL = resolveSpecUrl(_configuredSpec);
if (_configuredSpec && !isAllowedSpecUrl(_configuredSpec)) {
  // eslint-disable-next-line no-console
  console.warn(`[spec] ignoring VITE_SPEC_URL="${_configuredSpec}" — must be https:// or an absolute same-origin path; using ${SPEC_URL}`);
}

const WHITEPAPER_URL = "https://luckyprotocol.gitbook.io/luckyprotocol";

export default function Footer() {
  const [donate, setDonate] = useState(false);
  const [copied, setCopied] = useState(null); // null | "ok" | "fail"
  useEffect(() => {
    if (copied === null) return undefined;
    const id = setTimeout(() => setCopied(null), 2200);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <footer className="footer">
      <span>Yield is decided by the confirming block&apos;s hash. Nobody custodies BTC or tokens.</span>
      <span className="footer-links">
        <a href={WHITEPAPER_URL} target="_blank" rel="noopener noreferrer">
          Whitepaper
        </a>
        <span aria-hidden="true">·</span>
        <a href={SPEC_URL} target="_blank" rel="noopener noreferrer">
          Protocol spec v1
        </a>
        <span aria-hidden="true">·</span>
        <button type="button" className="footer-link" aria-expanded={donate} onClick={() => setDonate((v) => !v)}>
          Donate
        </button>
      </span>
      {donate && (
        <div className="footer-donate" role="region" aria-label="Donate">
          <span>Donations go to the protocol fee address (BTC on mainnet only):</span>
          <code className="mono">{PROJECT_FEE_ADDRESS}</code>
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => setCopied((await copyText(PROJECT_FEE_ADDRESS)) ? "ok" : "fail")}
            aria-label="Copy the donation address"
          >
            {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy"}
          </button>
        </div>
      )}
    </footer>
  );
}
