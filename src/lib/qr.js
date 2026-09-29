// QR code for the donation address — pure, unit-tested in plain Node.
//
// The code is drawn as SVG rectangles from the module matrix, so the page
// needs no image file and no data: URL, and the code always matches the
// address constant it is built from.
import qrcode from "qrcode-generator";

/** A BIP21 payment URI for `address` (lower-case bech32, as wallets expect). */
export function paymentUri(address) {
  return `bitcoin:${String(address).trim()}`;
}

/**
 * The module matrix of a QR code for `text`: `{ size, dark }` where
 * `dark[row][col]` is true for a dark module. Error correction M, the
 * smallest version that fits.
 */
export function qrMatrix(text) {
  const qr = qrcode(0, "M");
  qr.addData(String(text), "Byte");
  qr.make();
  const size = qr.getModuleCount();
  const dark = Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => qr.isDark(r, c)));
  return { size, dark };
}

/**
 * The dark modules as SVG path data, one `M x y h1 v1 h-1 z` square per
 * module, offset by the quiet zone `margin` (in modules).
 */
export function qrPath({ size, dark }, margin = 4) {
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (dark[r][c]) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return d;
}
