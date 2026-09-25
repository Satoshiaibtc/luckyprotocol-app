import { isAllowedSpecUrl, resolveSpecUrl } from "../lib/specUrl.js";

// VITE_SPEC_URL is validated like VITE_INDEXER_URL before it can become an
// href (https, or an absolute same-origin path); anything else falls back
// to the copy served from public/ (audit L-16).
const _configuredSpec = String(import.meta.env.VITE_SPEC_URL || "").trim();
const SPEC_URL = resolveSpecUrl(_configuredSpec);
if (_configuredSpec && !isAllowedSpecUrl(_configuredSpec)) {
  // eslint-disable-next-line no-console
  console.warn(`[spec] ignoring VITE_SPEC_URL="${_configuredSpec}" — must be https:// or an absolute same-origin path; using ${SPEC_URL}`);
}

export default function Footer() {
  return (
    <footer className="footer">
      <span>Yield is decided by the confirming block&apos;s hash. Nobody custodies BTC or tokens.</span>
      <span>
        <a href={SPEC_URL} target="_blank" rel="noopener noreferrer">
          Protocol spec v3
        </a>
      </span>
    </footer>
  );
}
