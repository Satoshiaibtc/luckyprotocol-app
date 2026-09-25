import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as indexer from "./lib/indexer.js";
import * as unisat from "./lib/unisat.js";
import { buildMinePsbt, estimateMineFeeSats, extractRawTxHex } from "./lib/psbt.js";
import { mineYield } from "./lib/yield.js";
import { PROJECT_FEE_ADDRESS } from "./lib/payloads.js";
import { usePoll } from "./hooks/usePoll.js";
import TopBar from "./components/TopBar.jsx";
import BlockStrip from "./components/BlockStrip.jsx";
import Console from "./components/Console.jsx";
import Activity from "./components/Activity.jsx";
import BalanceCard from "./components/BalanceCard.jsx";
import Footer from "./components/Footer.jsx";

const MOCK = indexer.isMock();
const DEFAULT_TICKER = "LUCKY";
const STATUS_POLL_MS = 15_000;
const RECONCILE_MAX_ATTEMPTS = 8;

const IDLE_MINE = { phase: "idle" };
const IDLE_WALLET = { status: "detecting", address: null, pubkeyHex: null, balance: null, error: null };

function friendlyError(e) {
  const msg = String(e?.message || e || "unknown error");
  if (/reject|denied|cancel/i.test(msg)) return "Signature declined in UniSat.";
  return msg;
}

export default function App() {
  // ---- wallet ---------------------------------------------------------------------------
  const [wallet, setWallet] = useState(IDLE_WALLET);

  useEffect(() => {
    let alive = true;
    unisat.detect(2000).then((p) => {
      if (alive) setWallet((w) => ({ ...w, status: p ? "disconnected" : "absent" }));
    });
    return () => {
      alive = false;
    };
  }, []);

  const refreshBalance = useCallback(async () => {
    try {
      const b = await unisat.getBalance();
      setWallet((w) => (w.status === "connected" ? { ...w, balance: b.total } : w));
    } catch {
      /* balance is cosmetic */
    }
  }, []);

  const connect = useCallback(async () => {
    setWallet((w) => ({ ...w, status: "connecting", error: null }));
    try {
      const { address, pubkeyHex } = await unisat.connect();
      setWallet({ status: "connected", address, pubkeyHex, balance: null, error: null });
      refreshBalance();
    } catch (e) {
      setWallet((w) => ({ ...w, status: unisat.hasProvider() ? "disconnected" : "absent", error: friendlyError(e) }));
    }
  }, [refreshBalance]);

  const disconnect = useCallback(() => {
    setWallet((w) => ({ ...IDLE_WALLET, status: unisat.hasProvider() ? "disconnected" : "absent", error: w.error }));
    setMine(IDLE_MINE);
  }, []);

  const useMock = useCallback(() => {
    try {
      unisat.enableMockWallet();
      connect();
    } catch (e) {
      setWallet((w) => ({ ...w, error: friendlyError(e) }));
    }
  }, [connect]);

  // Account / network changes from the extension.
  useEffect(() => {
    if (wallet.status !== "connected") return undefined;
    const offAcc = unisat.on("accountsChanged", (accounts) => {
      const next = Array.isArray(accounts) ? accounts[0] : null;
      if (!next) disconnect();
      else if (next !== wallet.address) connect();
    });
    const offNet = unisat.on("networkChanged", (net) => {
      if (net && net !== "livenet") {
        setWallet((w) => ({ ...w, status: "disconnected", address: null, pubkeyHex: null, balance: null, error: `UniSat switched to "${net}" — LuckyProtocol is mainnet only.` }));
        setMine(IDLE_MINE);
      }
    });
    return () => {
      offAcc();
      offNet();
    };
  }, [wallet.status, wallet.address, connect, disconnect]);

  // ---- indexer reads --------------------------------------------------------------------
  const address = wallet.status === "connected" ? wallet.address : null;

  const health = usePoll((s) => indexer.health(s), STATUS_POLL_MS, []);
  const tokensQ = usePoll((s) => indexer.tokens({ limit: 50 }, s), 30_000, []);
  const feesQ = usePoll((s) => indexer.fees(s), 60_000, []);
  const feed = usePoll((s) => indexer.minesFeed({ limit: 20 }, s), STATUS_POLL_MS, []);
  const myMines = usePoll(address ? (s) => indexer.minesByAddress(address, s) : null, STATUS_POLL_MS, [address]);
  const myBalances = usePoll(address ? (s) => indexer.balances(address, s) : null, STATUS_POLL_MS, [address]);

  const tipHeight = health.data?.tip_height ?? null;
  const tipBlock = usePoll(tipHeight ? (s) => indexer.blockInfo(tipHeight, s) : null, 0, [tipHeight]);

  const indexerOk = !health.error && !!health.data;

  // Stable handle for "refresh everything after a mine settles".
  const refreshAllRef = useRef(null);
  refreshAllRef.current = () => {
    health.refresh();
    tokensQ.refresh();
    feed.refresh();
    myMines.refresh();
    myBalances.refresh();
    refreshBalance();
  };

  // ---- ticker ------------------------------------------------------------------------------
  const tokens = useMemo(() => tokensQ.data?.items || [], [tokensQ.data]);
  const [ticker, setTicker] = useState(DEFAULT_TICKER);
  useEffect(() => {
    if (tokens.length === 0) return;
    if (!tokens.some((t) => t.ticker === ticker)) {
      setTicker(tokens.some((t) => t.ticker === DEFAULT_TICKER) ? DEFAULT_TICKER : tokens[0].ticker);
    }
  }, [tokens, ticker]);
  const tokenInfo = tokens.find((t) => t.ticker === ticker) || null;

  // ---- fee preview ----------------------------------------------------------------------------
  const feeRate = feesQ.data?.halfHourFee ?? null;
  const feeEstimate = useMemo(() => {
    if (!feeRate || !tokenInfo) return null;
    try {
      return estimateMineFeeSats({ address: address || PROJECT_FEE_ADDRESS, ticker, feeRateSatVb: feeRate });
    } catch {
      return null;
    }
  }, [feeRate, tokenInfo, address, ticker]);

  // ---- MINE state machine ----------------------------------------------------------------------
  const [mine, setMine] = useState(IDLE_MINE);

  const startMine = useCallback(async () => {
    if (wallet.status !== "connected" || !tokenInfo) return;
    const { address: addr, pubkeyHex } = wallet;
    setMine({ phase: "building", ticker });
    try {
      const [feeInfo, utxoRes, tokenRows] = await Promise.all([
        feesQ.data ? Promise.resolve(feesQ.data) : indexer.fees(),
        unisat.getBitcoinUtxos(addr),
        indexer.tokenUtxos(addr),
      ]);
      const tokenOutpoints = tokenRows.map(({ txid, vout }) => ({ txid, vout }));
      const built = buildMinePsbt({
        address: addr,
        pubkeyHex,
        utxos: utxoRes.utxos,
        tokenOutpoints,
        feeRateSatVb: feeInfo.halfHourFee,
        ticker,
      });
      setMine({
        phase: "signing",
        ticker,
        feeSats: built.feeSats,
        inputCount: built.inputIndexes.length,
        utxoSource: utxoRes.source,
      });

      const signed = await unisat.signPsbt(built.psbtHex, built.inputIndexes, addr);
      setMine((m) => ({ ...m, phase: "broadcasting" }));

      let txid;
      if (MOCK) {
        // Mock mode never touches the network: register a simulated broadcast.
        txid = await indexer.broadcast(signed, { address: addr, ticker });
      } else {
        try {
          txid = await unisat.pushPsbt(signed);
        } catch (pushErr) {
          // Fallback: extract the finalized raw tx and relay through the indexer.
          const raw = extractRawTxHex(signed);
          try {
            txid = await indexer.broadcast(raw, { address: addr, ticker });
          } catch (bErr) {
            throw new Error(`${friendlyError(pushErr)} · indexer relay: ${friendlyError(bErr)}`);
          }
        }
      }
      setMine((m) => ({ ...m, phase: "pending", txid, broadcastAt: Date.now() }));
      refreshBalance();
    } catch (e) {
      setMine((m) => ({ ...m, phase: "error", error: friendlyError(e) }));
    }
  }, [wallet, tokenInfo, ticker, feesQ.data, refreshBalance]);

  const resetMine = useCallback(() => setMine(IDLE_MINE), []);

  // Pending → poll /tx-status until confirmed; compute yield client-side.
  useEffect(() => {
    if (mine.phase !== "pending" || !mine.txid) return undefined;
    let alive = true;
    const txid = mine.txid;
    const check = async () => {
      try {
        const s = await indexer.txStatus(txid);
        if (!alive) return;
        if (s.confirmed && s.block_hash) {
          setMine((m) => ({
            ...m,
            phase: "confirmed",
            blockHeight: s.block_height,
            blockHash: s.block_hash,
            blockTime: s.block_time,
            yieldLocal: mineYield(s.block_hash),
            reconcile: "pending",
            pollError: null,
          }));
          refreshAllRef.current?.();
        } else {
          setMine((m) => ({ ...m, pollError: null, lastChecked: Date.now() }));
        }
      } catch (e) {
        if (alive) setMine((m) => ({ ...m, pollError: friendlyError(e) }));
      }
    };
    check();
    const id = setInterval(check, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mine.phase, mine.txid]);

  // Confirmed → reconcile with /mines/by-txid (the indexer is authoritative).
  useEffect(() => {
    if (mine.phase !== "confirmed" || mine.reconcile !== "pending" || !mine.txid) return undefined;
    let alive = true;
    let attempts = 0;
    const txid = mine.txid;
    const check = async () => {
      attempts += 1;
      try {
        const row = await indexer.mineByTxid(txid);
        if (!alive) return;
        if (row) {
          setMine((m) => ({ ...m, reconcile: "done", indexed: row }));
          refreshAllRef.current?.();
          return;
        }
      } catch {
        /* transient — retry on next tick */
      }
      if (alive && attempts >= RECONCILE_MAX_ATTEMPTS) {
        setMine((m) => ({ ...m, reconcile: "timeout" }));
      }
    };
    check();
    const id = setInterval(() => {
      if (attempts < RECONCILE_MAX_ATTEMPTS) check();
    }, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mine.phase, mine.reconcile, mine.txid]);

  // ---- render ---------------------------------------------------------------------------------
  return (
    <div className="app">
      <TopBar
        wallet={wallet}
        health={health}
        mock={MOCK}
        onConnect={connect}
        onDisconnect={disconnect}
        onUseMock={useMock}
      />

      <main className="col">
        <BlockStrip block={tipBlock.data} loading={tipBlock.loading || health.loading} error={tipBlock.error || health.error} ticker={ticker} />

        <div className="grid">
          <div className="col">
            <Console
              tokens={tokens}
              ticker={ticker}
              onTicker={setTicker}
              tokenInfo={tokenInfo}
              feeRate={feeRate}
              feeEstimate={feeEstimate}
              mine={mine}
              onMine={startMine}
              onReset={resetMine}
              wallet={wallet}
              mock={MOCK}
              indexerOk={indexerOk}
            />
          </div>
          <div className="col">
            <BalanceCard address={address} balances={myBalances} connected={!!address} />
            <Activity feed={feed} mine={myMines} connected={!!address} address={address} />
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
