// HARD RULE gate: zero gambling vocabulary anywhere in rendered source.
//
// Walks src/**/*.{js,jsx} plus src/styles.css, strips comments and the
// brand tokens, and fails on any denied word. Plain Node, no deps.
// The three unrendered trading components and src/lib/swap.js are skipped
// (kept in the codebase, never imported by a page); src/lib/mock.js is NOT
// skipped — its strings can surface in the UI.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const SRC = join(ROOT, "src");

const SKIP = new Set([
  "src/components/BuyPanel.jsx",
  "src/components/SellPanel.jsx",
  "src/components/PriceChart.jsx",
  "src/lib/swap.js",
]);

const DENY =
  /\b(bet|bets|betting|wager|wagers|win|wins|winner|winning|won|lose|loses|losing|loss|lost|jackpot|casino|slots?|dice|roulette|wheel|lottery|raffle|draws?|confetti|odds|payout|spin|spins|roll|rolls|prize|prizes|reward|rewards|chance|chances|gamble|gambling|lucky|luck)\b/i;

const BRAND = /LUCKY\/\/PROTOCOL|LuckyProtocol|LUCKYPROTOCOL|\bLUCKY\b/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}

// Strip // line comments and /* */ block comments while keeping line
// numbers stable (block comments are replaced by the same number of
// newlines). URLs ("https://") are not comments: only strip `//` that is
// not preceded by ':'.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

const files = walk(SRC)
  .map((p) => relative(ROOT, p).split(sep).join("/"))
  .filter((f) => !SKIP.has(f))
  .concat(["src/styles.css"]);

const hits = [];
for (const f of files) {
  const text = stripComments(readFileSync(join(ROOT, f), "utf8")).replace(BRAND, "");
  text.split("\n").forEach((line, i) => {
    const m = line.match(DENY);
    if (m) hits.push(`${f}:${i + 1}: "${m[0]}"`);
  });
}

if (hits.length) {
  console.error(`vocab: ${hits.length} denied word(s) found:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`vocab: ${files.length} files clean`);
