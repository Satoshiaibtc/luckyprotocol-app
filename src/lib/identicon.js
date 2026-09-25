// Deterministic token avatar: sha256(ticker) → a hue + a 5×5 horizontally
// symmetric pixel pattern. Same ticker → same picture on every device, no
// image hosting, no uploads (a DEPLOY carries nothing but the ticker).

import { sha256 } from "@noble/hashes/sha2.js";

const GRID = 5;

/** Pure data: `{ hue, cells: boolean[25], seed: Uint8Array }` */
export function identiconData(ticker) {
  const bytes = sha256(new TextEncoder().encode(`luckyprotocol:identicon:${String(ticker || "").toUpperCase()}`));
  const hue = Math.round((bytes[0] * 256 + bytes[1]) % 360);
  const cells = new Array(GRID * GRID).fill(false);
  // 15 bits decide the left half + middle column; the right half mirrors.
  let bit = 0;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < Math.ceil(GRID / 2); x++) {
      const on = ((bytes[2 + (bit >> 3)] >> (bit & 7)) & 1) === 1;
      bit += 1;
      cells[y * GRID + x] = on;
      cells[y * GRID + (GRID - 1 - x)] = on;
    }
  }
  // Guarantee at least a few lit cells so no token is a blank square.
  if (cells.filter(Boolean).length < 4) {
    cells[12] = true; cells[7] = true; cells[17] = true; cells[10] = true; cells[14] = true;
  }
  return { hue, cells };
}

/** Inline SVG markup string (used by the React component and by tests). */
export function identiconSvg(ticker, size = 40) {
  const { hue, cells } = identiconData(ticker);
  const bg = `hsl(${hue} 32% 14%)`;
  const fg = `hsl(${hue} 78% 62%)`;
  const cell = size / GRID;
  let rects = "";
  cells.forEach((on, i) => {
    if (!on) return;
    const x = (i % GRID) * cell;
    const y = Math.floor(i / GRID) * cell;
    rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${fg}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${String(ticker)} avatar"><rect width="${size}" height="${size}" fill="${bg}"/>${rects}</svg>`;
}
