#!/usr/bin/env node
// Spec ⇄ code gate. The site serves no spec file: the rules are published
// in the whitepaper, and the rulebook lives with the indexer. When
// LP_INDEXER_DIR names a local indexer checkout, its PROTOCOL.md §1
// constants table must name exactly the values src/lib/payloads.js builds
// transactions with, and the rulebook must state rules only (no audit
// reference, internal schema number, repository name, date or revision
// narrative — SPEC_PROCESS_DENY). Without it (the Pages build) the
// comparison is skipped; the local gates run it on every change.
//
// On every build it also fails when public/PROTOCOL.md exists, so a copy of
// the rulebook is never served again by accident.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** §1 row name → payloads.js export (FINAL_DEPTH is re-exported there from finality.js). */
export const SPEC_CONSTANTS = [
  "PROTOCOL_PREFIX",
  "ACTIVATION_HEIGHT",
  "REQUIRED_TOKEN_SUPPLY",
  "DUST_SATS",
  "PROJECT_FEE_ADDRESS",
  "DEPLOY_PROTOCOL_FEE_SATS",
  "MINE_PROTOCOL_FEE_SATS",
  "SEND_PROTOCOL_FEE_SATS",
  "MAX_OUT_IDX",
  "MIN_COMMIT_AGE",
  "MAX_COMMIT_AGE",
  "FINAL_DEPTH",
];

/**
 * The §1 constants table of a spec text → `{ NAME: value }` (numbers as
 * numbers, everything else as the bare string). Only the rows of the table
 * that follows the `## 1.` heading are read.
 */
export function parseSpecConstants(md) {
  const text = String(md || "");
  const start = text.search(/^## 1\. /m);
  if (start < 0) throw new Error("spec: no '## 1.' constants section");
  const rest = text.slice(start);
  const end = rest.slice(1).search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end + 1);
  const out = {};
  for (const line of section.split(/\r?\n/)) {
    const m = /^\|\s*`([A-Z0-9_]+)`\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (!m) continue;
    const raw = m[2].replace(/[`*]/g, "").trim();
    const num = raw.replace(/[_,]/g, "");
    out[m[1]] = /^\d+$/.test(num) ? Number(num) : raw;
  }
  return out;
}

/** Every mismatch between the spec's §1 table and `consts` as "NAME: spec X, code Y" lines. */
export function specConstantMismatches(md, consts) {
  const spec = parseSpecConstants(md);
  const out = [];
  for (const name of SPEC_CONSTANTS) {
    if (!(name in spec)) out.push(`${name}: missing from the spec's §1 table`);
    else if (!(name in consts)) out.push(`${name}: missing from src/lib/payloads.js`);
    else if (spec[name] !== consts[name]) out.push(`${name}: spec ${JSON.stringify(spec[name])}, code ${JSON.stringify(consts[name])}`);
  }
  return out;
}

/**
 * What the rulebook must never carry — it states the protocol, not the
 * project's process: [pattern, label] pairs, one hit per label per line.
 */
export const SPEC_PROCESS_DENY = [
  [/\baudit\b/i, "audit"],
  [/\b(19|20)\d\d-\d\d-\d\d\b/, "date"],
  [/\bluckyprotocol-[a-z]+\b/i, "repository"],
  [/\b[A-Z][A-Z0-9]*_VERSION\b/, "schema number"],
  [/\b(pre-activation|interim|editorial)\b/i, "revision narrative"],
];

/** Every line of a spec text that names internal process, as "line: label" entries. */
export function specProcessLeaks(md) {
  const out = [];
  String(md || "").split(/\r?\n/).forEach((line, i) => {
    for (const [re, label] of SPEC_PROCESS_DENY) if (re.test(line)) out.push(`${i + 1}: ${label}`);
  });
  return out;
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (existsSync(join(root, "public", "PROTOCOL.md"))) {
    console.error("spec file: public/PROTOCOL.md exists — the site serves no spec file; delete it");
    process.exit(1);
  }
  console.log("spec file: public/ carries no spec file");

  const dir = String(process.env.LP_INDEXER_DIR || "").trim();
  const specPath = dir ? join(dir, "PROTOCOL.md") : null;
  if (!specPath || !existsSync(specPath)) {
    console.log("spec constants: LP_INDEXER_DIR not set — the comparison runs in the local gates");
    return;
  }
  const md = readFileSync(specPath, "utf8");
  const payloads = await import(pathToFileURL(join(root, "src", "lib", "payloads.js")).href);
  const bad = specConstantMismatches(md, payloads);
  if (bad.length) {
    console.error("spec constants: the indexer's PROTOCOL.md §1 and src/lib/payloads.js disagree:");
    for (const b of bad) console.error(`  ${b}`);
    process.exit(1);
  }
  console.log(`spec constants: the indexer's PROTOCOL.md §1 matches src/lib/payloads.js (${SPEC_CONSTANTS.length} constants)`);

  const leaks = specProcessLeaks(md);
  if (leaks.length) {
    console.error("spec scope: the rulebook narrates internal process (it states rules only):");
    for (const l of leaks) console.error(`  PROTOCOL.md:${l}`);
    process.exit(1);
  }
  console.log("spec scope: the rulebook names no audit, schema number, repository, date or revision narrative");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
