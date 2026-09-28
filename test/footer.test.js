import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROJECT_FEE_ADDRESS } from "../src/lib/payloads.js";

// The footer links the whitepaper and the spec and offers the protocol fee
// address for donations; it prints no build fingerprint (a commit hash
// points straight at a repository and a moment in its history).
const footer = readFileSync(new URL("../src/components/Footer.jsx", import.meta.url), "utf8");
const vite = readFileSync(new URL("../vite.config.js", import.meta.url), "utf8");
assert.ok(footer.includes('"https://luckyprotocol.gitbook.io/luckyprotocol"'), "whitepaper link");
assert.ok(/>\s*Whitepaper\s*</.test(footer) && /Protocol spec v1/.test(footer) && />\s*Donate\s*</.test(footer), "three controls");
assert.ok(footer.includes("PROJECT_FEE_ADDRESS") && /^bc1p[0-9a-z]{58}$/.test(PROJECT_FEE_ADDRESS), "donations go to the fee address");
for (const src of [footer, vite]) {
  assert.ok(!/BUILD_COMMIT|CF_PAGES_COMMIT/.test(src), "no build fingerprint");
}
console.log("footer: whitepaper + spec + donate (fee address); no build commit");
