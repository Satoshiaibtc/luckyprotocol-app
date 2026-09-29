// Public-surface gate: the repository's text never narrates its own
// process. Plain Node, no deps.
//
// This repository is public. Its comments, doc comments, test names and
// messages say what the code does and why — never how the text came to
// be: no finding or review ids, no dated decisions, no history. Every text
// file under src/, test/ and scripts/, plus index.html, vite.config.js and
// eslint.config.js, is scanned line by line, and every hit fails with
// file:line. Two files are left out: this one (its patterns would match
// their own source) and the served spec, public/PROTOCOL.md, which is
// frozen and checked by scripts/check-spec.mjs.
//
// A calendar date is history only when the text says it, not when the code
// handles it: fixtures feed dates (including deliberately invalid ones) to
// the functions under test, so the date rule reads comments and prose
// only, never string literals.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const DIRS = ["src", "test", "scripts"];
const ROOT_FILES = ["index.html", "vite.config.js", "eslint.config.js"];
const EXCLUDE = new Set(["test/internals.test.js", "public/PROTOCOL.md"]);
const TEXT_FILE = /\.(js|jsx|mjs|cjs|css|html|md|json|svg|txt)$/i;
const PROSE_FILE = /\.(md|txt)$/i;

// What must not appear anywhere on a line, and what a hit is reported as.
const DENY = [
  [/\baudit\s+[A-Za-z]+-\d/, "finding id"],
  [/\(audit\b/, "finding id"],
  [/\bowner decision\b/, "dated decision"],
  [/\b(usertx|visit|market|portfolio|mine|consensus|wallet|trading|rvs|web|api)-\d+\b/, "finding id"],
  [/\bG\d{1,2}\b(?=[\s),.:;])/, "finding id"],
  [/\.\.\/\.\.\/[A-Za-z0-9_-]+\//, "path into another checkout"],
  [/\b[\w-]+\.rs\b/, "private source file"],
];
// What must not appear in comment or prose text.
const DENY_IN_COMMENTS = [[/\b20\d\d-\d\d-\d\d\b/, "date"]];
// Lines that hold a marker on purpose: the sample a leak detector is fed
// to prove it fires.
const ALLOW_LINE = [/specProcessLeaks\("/];

// The comment part of a source line: a whole comment line, or the tail
// after a trailing "//" (preceded by whitespace, so "https://" is not one).
function commentText(line) {
  const t = line.trim();
  if (/^(\/\/|\/\*|\*|\{\/\*|<!--)/.test(t)) return t;
  const m = line.match(/\s\/\/(.*)$/);
  return m ? m[1] : "";
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT_FILE.test(name)) out.push(p);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(join(ROOT, d)))
  .map((p) => relative(ROOT, p).split(sep).join("/"))
  .concat(ROOT_FILES.filter((f) => existsSync(join(ROOT, f))))
  .filter((f) => !EXCLUDE.has(f));

const hits = [];
for (const f of files) {
  readFileSync(join(ROOT, f), "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (ALLOW_LINE.some((re) => re.test(line))) return;
      const check = (rules, text) => {
        for (const [re, what] of rules) {
          const m = text.match(re);
          if (m) hits.push(`${f}:${i + 1}: "${m[0]}" (${what})`);
        }
      };
      check(DENY, line);
      check(DENY_IN_COMMENTS, PROSE_FILE.test(f) ? line : commentText(line));
    });
}

if (hits.length) {
  console.error(`internals: ${hits.length} process marker(s) found — public text says what and why, never how it got there:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`internals: ${files.length} files clean (no finding ids, dated decisions or history)`);
