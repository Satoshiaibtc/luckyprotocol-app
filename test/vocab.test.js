// HARD RULE gates. Plain Node, no deps.
//
// 1. Zero gambling vocabulary anywhere in rendered source. Walks
//    src/**/*.{js,jsx} plus src/styles.css, strips comments and the brand
//    tokens, and fails on any denied word. Nothing is skipped: the trading
//    components render again (Market tab), and src/lib/mock.js strings can
//    surface in the UI. `_` counts as a word break, so a denied word inside
//    a snake_case or UPPER_CASE identifier is caught too (`\b` alone treats
//    `_` as a word character and would miss it).
//
// 2. Public naming: LUCKY-20 is published as a new protocol at version v1.
//    No text file of this public repository (src/, public/, scripts/,
//    test/ and the root files listed in NAMING_ROOT_FILES) may carry an
//    older version word or a versioned spec path. Comments are checked
//    too. The patterns below are
//    written so that they never match their own source text, so this file
//    is scanned like every other one.
//
// 3. The same vocabulary rule for every text file the site serves as is:
//    public/** and index.html. Nothing is stripped there except the brand tokens: a
//    comment in a served file is served too.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const SRC = join(ROOT, "src");

const SKIP = new Set();

const DENY =
  /\b(bet|bets|betting|wager|wagers|win|wins|winner|winning|won|lose|loses|losing|loss|lost|jackpot|casino|slots?|dice|roulette|wheel|lottery|raffle|draws?|confetti|odds|payout|spin|spins|roll|rolls|prize|prizes|reward|rewards|chance|chances|gamble|gambling|lucky|luck)\b/i;

// The brand tokens, exact and case-sensitive. `lucky-20` is the brand's wire
// id — the value of every payload's `p` key (spec §1 PROTOCOL_ID).
const BRAND = /LUCKY\/\/PROTOCOL|LuckyProtocol|LUCKY-20|lucky-20|\bLUCKY\b/g;

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

// `_` is a word character for `\b`: split identifiers on it before matching.
const words = (text) => text.replace(BRAND, "").replace(/_/g, " ");

// Self-check: the exemption is the exact brand tokens only.
for (const [sample, denied] of [
  ['{"p":"lucky-20","op":"mine"}', false],
  ["LUCKY-20 v1", false],
  ["LUCKY", false],
  ["lucky", true],
  ["Lucky-20", true],
  ["a lucky block", true],
]) {
  if (DENY.test(words(sample)) !== denied) {
    console.error(`vocab: self-check failed for ${JSON.stringify(sample)} (expected ${denied ? "denied" : "allowed"})`);
    process.exit(1);
  }
}

const hits = [];
for (const f of files) {
  const text = words(stripComments(readFileSync(join(ROOT, f), "utf8")));
  text.split("\n").forEach((line, i) => {
    const m = line.match(DENY);
    if (m) hits.push(`${f}:${i + 1}: "${m[0]}"`);
  });
}

// ---- 3. served public text -------------------------------------------------------------------------

const SERVED_TEXT = /\.(md|html|txt|json|svg|webmanifest|xml|css|js)$/i;
function walkServed(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkServed(p, out);
    else if (SERVED_TEXT.test(name)) out.push(p);
  }
  return out;
}
const servedFiles = walkServed(join(ROOT, "public"))
  .map((p) => relative(ROOT, p).split(sep).join("/"))
  .concat(["index.html"]);
const servedHits = [];
for (const f of servedFiles) {
  words(readFileSync(join(ROOT, f), "utf8"))
    .split("\n")
    .forEach((line, i) => {
      const m = line.match(DENY);
      if (m) servedHits.push(`${f}:${i + 1}: "${m[0]}"`);
    });
}

// ---- 2. public naming gate -----------------------------------------------------------------------------------

// A standalone version word (the letter v followed by 2 or 3, any case),
// and a versioned spec file name (PROTOCOL-v followed by a digit).
const NAMING_DENY = [/\bv[23]\b/i, /PROTOCOL-v\d/i];
const NAMING_DIRS = ["src", "public", "scripts", "test"];
const NAMING_ROOT_FILES = ["index.html", "package.json", ".env.example", "vite.config.js", "eslint.config.js"];
const TEXT_FILE = /\.(js|jsx|mjs|cjs|css|html|md|json|svg|txt)$/i;

function walkText(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkText(p, out);
    else if (TEXT_FILE.test(name)) out.push(p);
  }
  return out;
}

const namingFiles = NAMING_DIRS.flatMap((d) => walkText(join(ROOT, d)))
  .map((p) => relative(ROOT, p).split(sep).join("/"))
  .concat(NAMING_ROOT_FILES.filter((f) => existsSync(join(ROOT, f))));

const namingHits = [];
for (const f of namingFiles) {
  readFileSync(join(ROOT, f), "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const re of NAMING_DENY) {
        const m = line.match(re);
        if (m) namingHits.push(`${f}:${i + 1}: "${m[0]}"`);
      }
    });
}

let failed = false;
if (hits.length) {
  console.error(`vocab: ${hits.length} denied word(s) found:`);
  for (const h of hits) console.error(`  ${h}`);
  failed = true;
} else {
  console.log(`vocab: ${files.length} files clean`);
}
if (servedHits.length) {
  console.error(`vocab: ${servedHits.length} denied word(s) in served public text:`);
  for (const h of servedHits) console.error(`  ${h}`);
  failed = true;
} else {
  console.log(`vocab: ${servedFiles.length} served public text files clean`);
}
if (namingHits.length) {
  console.error(`naming: ${namingHits.length} version word(s) found (the protocol is published as LUCKY-20 v1):`);
  for (const h of namingHits) console.error(`  ${h}`);
  failed = true;
} else {
  console.log(`naming: ${namingFiles.length} files clean (no older version word, no versioned spec path)`);
}
if (failed) process.exit(1);
