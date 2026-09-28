#!/usr/bin/env node
// Spec ⇄ code gate that runs on EVERY build, including the Cloudflare Pages
// build (npm run build → prebuild), where the indexer checkout that
// test/web.test.js compares against byte-for-byte is not present.
//
// public/PROTOCOL.md is the spec the site serves. Its §1 constants table
// must name exactly the values src/lib/payloads.js builds transactions with.
// A code change that bumps a consensus constant (the SNAPSHOT_VERSION of a
// rule change, a fee, the activation height) without the matching spec copy
// — or a spec copy without the code — fails the build instead of shipping a
// page that documents rules the app does not follow.
//
// It also checks where the footer's "Protocol spec" link will point
// (VITE_SPEC_URL, audit F7). The host answers every unknown path with the
// app page, so a same-origin value that names no file in public/ — for
// example an earlier spec file name left in the Pages settings — would
// open the app instead of the spec. Such a value fails the build.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAllowedSpecUrl } from "../src/lib/specUrl.js";
import { loadEnv } from "./gen-headers.mjs";

/** §1 row name → payloads.js export (FINAL_DEPTH is re-exported there from finality.js). */
export const SPEC_CONSTANTS = [
  "PROTOCOL_PREFIX",
  "ACTIVATION_HEIGHT",
  "SNAPSHOT_VERSION",
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
 * Why a VITE_SPEC_URL value would not open the spec, or null when it is
 * fine. Empty means the default /PROTOCOL.md. A same-origin path must name
 * a file in `publicDir` (query and fragment ignored); an https URL is
 * another host and is not checked here; anything else is a value the
 * footer would ignore, reported so a typo fails the build.
 */
export function specUrlProblem(value, publicDir) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  if (!isAllowedSpecUrl(s)) return `VITE_SPEC_URL="${s}" is neither an https URL nor an absolute same-origin path`;
  if (!s.startsWith("/")) return null;
  let segments;
  try {
    segments = decodeURIComponent(s.replace(/[?#].*$/, "")).split("/").filter(Boolean);
  } catch {
    return `VITE_SPEC_URL="${s}" is not a valid path`;
  }
  if (segments.includes("..")) return `VITE_SPEC_URL="${s}" leaves public/`;
  const file = join(publicDir, ...segments);
  if (!segments.length || !existsSync(file) || !statSync(file).isFile()) {
    return `VITE_SPEC_URL="${s}" names no file in public/, so the footer link would open the app page instead of the spec`;
  }
  return null;
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const md = readFileSync(join(root, "public", "PROTOCOL.md"), "utf8");
  const payloads = await import(pathToFileURL(join(root, "src", "lib", "payloads.js")).href);
  const bad = specConstantMismatches(md, payloads);
  if (bad.length) {
    console.error("spec constants: public/PROTOCOL.md §1 and src/lib/payloads.js disagree:");
    for (const b of bad) console.error(`  ${b}`);
    console.error("Copy the indexer's PROTOCOL.md over public/PROTOCOL.md (and update payloads.js) before building.");
    process.exit(1);
  }
  console.log(`spec constants: public/PROTOCOL.md §1 matches src/lib/payloads.js (${SPEC_CONSTANTS.length} constants, SNAPSHOT_VERSION ${payloads.SNAPSHOT_VERSION})`);

  const env = loadEnv(process.env.MODE || "production", root);
  const linkProblem = specUrlProblem(env.VITE_SPEC_URL, join(root, "public"));
  if (linkProblem) {
    console.error(`spec link: ${linkProblem}. Unset it (the default is /PROTOCOL.md) or point it at a file that exists.`);
    process.exit(1);
  }
  console.log(`spec link: ${String(env.VITE_SPEC_URL || "").trim() || "/PROTOCOL.md (default)"}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
