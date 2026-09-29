// Test helper (not a test file): the simulated wallet's spendable BTC as a
// build reads it — the wallet's own list (mockWalletUtxos), checked with the
// mock's GET /txouts, kept by verifyWalletUtxos. `mock` is the imported
// src/lib/mock.js module (the tests import it after their own set-up).
import { hex } from "@scure/base";
import { decodeAddress } from "../src/lib/psbt.js";
import { collectWalletUtxos, verifyWalletUtxos } from "../src/lib/walletShapes.js";

/** → verifyWalletUtxos' result: `{ utxos, waitingOutpoints, carrierOutpoints, …, waitingSats }`. */
export async function mockSpendable(mock, address) {
  const listed = await collectWalletUtxos(() => mock.mockWalletUtxos(address));
  const rows = [];
  for (let i = 0; i < listed.length; i += 100) {
    const o = listed
      .slice(i, i + 100)
      .map((u) => `${u.txid}:${u.vout}`)
      .join(",");
    rows.push(...(await mock.mockGet(`/txouts?o=${o}`)));
  }
  return verifyWalletUtxos(listed, rows, { scriptHex: hex.encode(decodeAddress(address).script) });
}
