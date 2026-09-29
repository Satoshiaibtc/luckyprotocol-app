import { useState } from "react";
import DonateModal from "./DonateModal.jsx";

const WHITEPAPER_URL = "https://luckyprotocol.gitbook.io/luckyprotocol";

export default function Footer() {
  const [donate, setDonate] = useState(false);

  return (
    <footer className="footer">
      <span>Yield is decided by the confirming block&apos;s hash. Nobody custodies BTC or tokens.</span>
      <span className="footer-links">
        <a href={WHITEPAPER_URL} target="_blank" rel="noopener noreferrer">
          Whitepaper
        </a>
        <span aria-hidden="true">·</span>
        <button type="button" className="footer-link" aria-haspopup="dialog" onClick={() => setDonate(true)}>
          Donate
        </button>
      </span>
      <DonateModal open={donate} onClose={() => setDonate(false)} />
    </footer>
  );
}
