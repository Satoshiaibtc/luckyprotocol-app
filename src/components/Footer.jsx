const SPEC_URL = import.meta.env.VITE_SPEC_URL || "/PROTOCOL-v3.md";

export default function Footer() {
  return (
    <footer className="footer">
      <span>Yield is decided by the confirming block&apos;s hash — public and independently verifiable.</span>
      <span>
        <a href={SPEC_URL} target="_blank" rel="noopener noreferrer">
          Protocol spec v3
        </a>
      </span>
    </footer>
  );
}
