import assert from "node:assert/strict";
import { AVATAR_SIDE_PX, MAX_AVATAR_BYTES, TARGET_AVATAR_BYTES, compressAvatar } from "../src/lib/inscribe.js";

const file = { name: "avatar.png", type: "image/png", size: 1000 };
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
let encode;
let sourceSide;
let closed;
let calls;

globalThis.createImageBitmap = async () => ({ width: sourceSide, height: sourceSide, close: () => { closed++; } });
globalThis.document = {
  createElement: () => ({
    getContext: () => ({ drawImage() {} }),
    toBlob(callback, type, quality) {
      const input = { side: this.width, type, quality };
      calls.push(input);
      const out = encode(input);
      callback(out ? new Blob([new Uint8Array(out.size)], { type: out.type ?? type }) : null);
    },
  }),
};

async function run(encoder, side = 1024) {
  encode = encoder;
  sourceSide = side;
  closed = 0;
  calls = [];
  try { return await compressAvatar(file); }
  finally { assert.equal(closed, 1, "decoded bitmap is released even when compression fails"); }
}

try {
  assert.equal(AVATAR_SIDE_PX, 128);
  assert.equal(TARGET_AVATAR_BYTES, 4096);
  assert.equal(MAX_AVATAR_BYTES, 16384, "protocol hard limit stays unchanged");
  const simple = await run(() => ({ size: 900 }));
  assert.equal(simple.width, 128);
  assert.equal(simple.height, 128);
  assert.equal(simple.quality, 0.85);
  assert.equal(calls.length, 1);

  const complex = await run(({ side, quality }) => ({ size: side === 96 && quality <= 0.7 ? 3500 : 6000 }));
  assert.equal(complex.width, 96);
  assert.equal(complex.quality, 0.7);
  assert.ok(complex.bytes.length <= TARGET_AVATAR_BYTES);
  assert.deepEqual([...new Set(calls.map((c) => c.side))], [128, 96]);

  const small = await run(({ side }) => ({ size: side === 64 ? 2500 : 7000 }));
  assert.equal(small.width, 64);
  const tinySource = await run(() => ({ size: 500 }), 32);
  assert.equal(tinySource.width, 32, "small originals are not enlarged");

  const png = await run(({ type, side }) => ({ type: "image/png", size: type === "image/webp" ? 20000 : side === 64 ? 3000 : 20000 }));
  assert.equal(png.contentType, "image/png");
  assert.equal(png.width, 64);
  assert.equal(png.quality, null);

  const fallback = await run(({ side }) => ({ size: side === 64 ? 5000 : 20000 }));
  assert.equal(fallback.bytes.length, 5000, "smallest valid encoding may exceed the soft target");
  assert.equal(fallback.width, 64);
  await assert.rejects(run(() => ({ size: 20000 })), /16,384 bytes/);
  await assert.rejects(run(() => null), /16,384 bytes/);
  await assert.rejects(compressAvatar({ ...file, name: "bad.svg", type: "image/svg+xml" }), /SVG is not supported/);
  await assert.rejects(compressAvatar({ ...file, size: 40 * 1024 * 1024 + 1 }), /40 MB/);
  console.log("avatar compression: 128/96/64 px, 4 KiB target, no upscaling, PNG fallback, hard bounds and bitmap cleanup passed");
} finally {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else delete globalThis.document;
  if (originalBitmap) Object.defineProperty(globalThis, "createImageBitmap", originalBitmap);
  else delete globalThis.createImageBitmap;
}
