import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROJECT_FEE_ADDRESS } from "../src/lib/payloads.js";
import { paymentUri, qrMatrix, qrPath } from "../src/lib/qr.js";

// The footer links the whitepaper and opens the Donate dialog; it links no
// spec file and prints no build fingerprint (a commit hash points straight
// at a repository and a moment in its history).
const footer = readFileSync(new URL("../src/components/Footer.jsx", import.meta.url), "utf8");
const donate = readFileSync(new URL("../src/components/DonateModal.jsx", import.meta.url), "utf8");
const vite = readFileSync(new URL("../vite.config.js", import.meta.url), "utf8");
assert.ok(footer.includes('"https://luckyprotocol.gitbook.io/luckyprotocol"'), "whitepaper link");
assert.ok(/>\s*Whitepaper\s*</.test(footer) && />\s*Donate\s*</.test(footer), "two controls");
assert.ok(!/spec|PROTOCOL\.md/i.test(footer), "no spec link");
assert.ok(footer.includes("<DonateModal"), "Donate opens the dialog");
for (const src of [footer, vite]) {
  assert.ok(!/BUILD_COMMIT|CF_PAGES_COMMIT/.test(src), "no build fingerprint");
}

// The dialog shows the fee address as text and as a QR code of its payment URI.
assert.ok(/^bc1p[0-9a-z]{58}$/.test(PROJECT_FEE_ADDRESS), "donations go to the fee address");
assert.ok(donate.includes("PROJECT_FEE_ADDRESS") && donate.includes("qrMatrix") && donate.includes('role="dialog"'), "address, QR code, dialog");
assert.equal(paymentUri(` ${PROJECT_FEE_ADDRESS} `), `bitcoin:${PROJECT_FEE_ADDRESS}`);

{
  const m = qrMatrix(paymentUri(PROJECT_FEE_ADDRESS));
  assert.ok(m.size >= 21 && (m.size - 17) % 4 === 0, `a valid QR size (${m.size})`);
  assert.equal(m.dark.length, m.size);
  for (const row of m.dark) assert.equal(row.length, m.size);
  // The three finder patterns: a dark 7x7 ring with a dark 3x3 centre.
  const finder = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const centre = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(m.dark[r0 + r][c0 + c], ring || centre, `finder at ${r0},${c0} module ${r},${c}`);
      }
    }
  };
  finder(0, 0);
  finder(0, m.size - 7);
  finder(m.size - 7, 0);
  // One path square per dark module, shifted by the quiet zone.
  const darkCount = m.dark.flat().filter(Boolean).length;
  const path = qrPath(m, 4);
  assert.equal((path.match(/M/g) || []).length, darkCount);
  assert.ok(path.startsWith("M4 4h1v1h-1z"), "the top-left module sits inside the quiet zone");
  // The same address always gives the same code.
  assert.deepEqual(qrMatrix(paymentUri(PROJECT_FEE_ADDRESS)), m);
}
console.log("footer: whitepaper + donate dialog (fee address, QR code); no spec link; no build commit");
