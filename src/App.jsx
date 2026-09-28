import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as indexer from "./lib/indexer.js";
import { chainTipOf, syncStateOf, syncWarningText } from "./lib/sync.js";
import { NETWORK_POLL_MS, confirmedNetworkLag, fetchNetworkFees, fetchNetworkTip, mergeFeeSources, networkLag } from "./lib/network.js";
import { setIndexedTip, setUnseenTrusted } from "./lib/txrecords.js";
import { mockNetworkFees, mockNetworkTip } from "./lib/mock.js";
import { usePoll } from "./hooks/usePoll.js";
import { useWallet } from "./hooks/useWallet.js";
import { useFeeRate } from "./hooks/useFeeRate.js";
import { useHashRoute } from "./hooks/useHashRoute.js";
import { useIsMobile } from "./hooks/useMediaQuery.js";
import { AppContext } from "./context.js";
import TopBar from "./components/TopBar.jsx";
import WalletModal from "./components/WalletModal.jsx";
import TabBar from "./components/TabBar.jsx";
import MineTicker from "./components/MineTicker.jsx";
import Footer from "./components/Footer.jsx";
import Board from "./pages/Board.jsx";
import TokenPage from "./pages/TokenPage.jsx";
import CreatePage from "./pages/CreatePage.jsx";
import PortfolioPage from "./pages/PortfolioPage.jsx";
import SendPage from "./pages/SendPage.jsx";
import ActivityPage from "./pages/ActivityPage.jsx";
import MarketPage from "./pages/MarketPage.jsx";
import ProbabilityPage from "./pages/ProbabilityPage.jsx";
import { activationBannerText } from "./lib/activation.js";

const MOCK = indexer.isMock();
const STATUS_POLL_MS = 15_000;
// While the indexer is behind the tip, re-read /health faster so the pages
// that pause on a lag (Create, Mine) unlock as soon as it has caught up.
const LAGGING_POLL_MS = 5_000;

/**
 * The site-wide line under the top bar while the protocol is not active yet
 * (audit visit-3): every page — the board's "anyone can mine it", an empty
 * Market or Activity — reads differently when nothing can be created or
 * mined for another few days. At tip ACTIVATION_HEIGHT − 1 it says that
 * Reserve and Mine are already open (decision B). Hidden while the tip is
 * unknown (the gates still fail closed and each action says so) and from
 * activation on.
 */
function ActivationBanner({ tip }) {
  const text = activationBannerText(tip);
  if (!text) return null;
  return (
    <div className="activation-banner" role="note">
      <span>{text}</span>
    </div>
  );
}

/**
 * The site-wide line under the top bar while our data may be out of date:
 * a rebuild, a stalled indexer, a node without peers or behind the network
 * (src/lib/sync.js syncWarningText). Hidden while everything is current.
 */
function SyncBanner({ sync, tipTime }) {
  const text = syncWarningText(sync, { tipTime });
  if (!text) return null;
  return (
    <div className="activation-banner sync-banner" role="alert">
      <span>{text}</span>
    </div>
  );
}

export default function App() {
  const { route, navigate } = useHashRoute();
  const w = useWallet();
  const mobile = useIsMobile();
  // The one wallet dialog (WalletModal): opened from the top bar and every ConnectPrompt.
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const openWalletModal = useCallback(() => setWalletModalOpen(true), []);
  const closeWalletModal = useCallback(() => setWalletModalOpen(false), []);

  // ---- app-wide indexer reads ----------------------------------------------------------
  const [statusPollMs, setStatusPollMs] = useState(STATUS_POLL_MS);
  const health = usePoll((s) => indexer.health(s), statusPollMs, []);
  // The second source's tip, every NETWORK_POLL_MS (src/lib/network.js): a
  // node that lost its peers or was fed an old chain still calls itself
  // synced — only an independent tip shows it. The URL carries no user data.
  const netTip = usePoll(() => (MOCK ? mockNetworkTip() : fetchNetworkTip()), NETWORK_POLL_MS, []);
  // The node's tip, never below what the indexer has applied (it reads 0 for
  // a moment after an indexer restart, which is no lag behind the network).
  const nodeTip = chainTipOf(health.data);
  const lagTrackerRef = useRef({ read: null, tracker: null });
  const [netLag, setNetLag] = useState(0);
  useEffect(() => {
    const t = lagTrackerRef.current;
    const now = Date.now();
    if (netTip.updatedAt !== null && netTip.updatedAt !== t.read) {
      t.read = netTip.updatedAt;
      t.tracker = networkLag(t.tracker, { networkTip: netTip.error ? null : netTip.data, tip: nodeTip, now });
    }
    setNetLag(confirmedNetworkLag(t.tracker, nodeTip, now));
  }, [netTip.updatedAt, netTip.data, netTip.error, nodeTip]);
  const sync = useMemo(() => syncStateOf(health.error ? null : health.data, { networkLag: netLag }), [health.data, health.error, netLag]);
  // Records of this browser's broadcasts drop a tx the node "does not know"
  // only while that answer means something (src/lib/txrecords.js).
  useEffect(() => {
    setUnseenTrusted(sync.trustUnseen);
    setIndexedTip(sync.indexed);
  }, [sync.trustUnseen, sync.indexed]);
  useEffect(() => {
    setStatusPollMs(sync.lag > 0 ? LAGGING_POLL_MS : STATUS_POLL_MS);
  }, [sync.lag]);
  const tokens = usePoll((s) => indexer.tokens({ limit: 200 }, s), 30_000, []);
  const tipHeight = chainTipOf(health.data);
  const feesPoll = usePoll((s) => indexer.fees(s), 30_000, [tipHeight]);
  // The second source's recommended rates: the Fast tier follows it when it
  // is higher, and it stands in when the indexer's node has no estimate —
  // estimates the indexer marks `ok: false` are never used (network.js).
  const netFees = usePoll(() => (MOCK ? mockNetworkFees() : fetchNetworkFees()), NETWORK_POLL_MS, []);
  const mergedFees = useMemo(
    () => mergeFeeSources(feesPoll.error ? null : feesPoll.data, netFees.error ? null : netFees.data),
    [feesPoll.data, feesPoll.error, netFees.data, netFees.error],
  );
  const hasFees = mergedFees.source !== null;
  const fees = useMemo(
    () => ({ ...feesPoll, data: feesPoll.data || hasFees ? mergedFees : null, error: hasFees ? null : feesPoll.error }),
    [feesPoll, mergedFees, hasFees],
  );
  // One fee choice (preset from /fees or custom sat/vB) for every builder.
  const fee = useFeeRate(fees.error ? null : fees.data);
  const tipBlock = usePoll(tipHeight ? (s) => indexer.blockInfo(tipHeight, s) : null, 0, [tipHeight]);
  // USD per BTC from /price — secondary and optional: null (or an error)
  // simply hides every USD sub-label; nothing else depends on it.
  const price = usePoll((s) => indexer.price(s), 60_000, []);
  const indexerOk = !health.error && !!health.data;

  // Start the indexer's UTXO scan for a wallet as soon as it connects (api-1):
  // the first /btc-utxos query of an address queues a scan that takes a
  // minute or two, and it is better spent while the user looks around than
  // after they press Mine. Fire-and-forget: the 503 / 429 is expected.
  const connectedAddress = w.connected ? w.address : null;
  useEffect(() => {
    if (!connectedAddress || MOCK) return;
    indexer.btcUtxos(connectedAddress).catch(() => {});
  }, [connectedAddress]);

  // Stable "refresh everything" handle for flows that settle on-chain.
  const refreshAllRef = useRef(null);
  refreshAllRef.current = () => {
    health.refresh();
    tokens.refresh();
    fees.refresh();
    w.refreshBalance();
  };
  const refreshAll = useCallback(() => refreshAllRef.current?.(), []);

  const ctx = useMemo(
    () => ({
      wallet: w.wallet,
      connected: w.connected,
      address: w.address,
      pubkeyHex: w.pubkeyHex,
      connect: w.connect,
      disconnect: w.disconnect,
      useMock: w.useMock,
      refreshBalance: w.refreshBalance,
      walletModalOpen,
      openWalletModal,
      closeWalletModal,
      health,
      tokens,
      fees,
      fee,
      price,
      tipBlock,
      indexerOk,
      sync,
      mock: MOCK,
      route,
      navigate,
      refreshAll,
    }),
    [w.wallet, w.connected, w.address, w.pubkeyHex, w.connect, w.disconnect, w.useMock, w.refreshBalance, walletModalOpen, openWalletModal, closeWalletModal, health, tokens, fees, fee, price, tipBlock, indexerOk, sync, route, navigate, refreshAll],
  );

  let page;
  switch (route.name) {
    case "token":
      page = <TokenPage key={route.ticker} ticker={route.ticker} params={route.params} navigate={navigate} />;
      break;
    case "create":
      // Keyed on ?ticker=: a new name in the hash (the board's "Create X",
      // a token page's link) remounts the page with that name in the field.
      page = <CreatePage key={route.params.ticker || ""} params={route.params} navigate={navigate} />;
      break;
    case "me":
      page = <PortfolioPage />;
      break;
    case "send":
      // Keyed on the ticker and the pre-selected carrier: a new split link remounts the form.
      page = <SendPage key={`${route.ticker}:${route.params.utxo || ""}:${route.params.to || ""}`} ticker={route.ticker} params={route.params} />;
      break;
    case "activity":
      page = <ActivityPage />;
      break;
    case "market":
      page = <MarketPage />;
      break;
    case "probability":
      page = <ProbabilityPage />;
      break;
    case "notfound":
      page = <Board notice={`Nothing at "#${route.path}" — showing the board.`} />;
      break;
    default:
      page = <Board />;
  }

  return (
    <AppContext.Provider value={ctx}>
      <div className={`app${mobile ? " app-mobile" : ""}`}>
        <TopBar />
        <ActivationBanner tip={tipHeight} />
        {!health.error && health.data && <SyncBanner sync={sync} tipTime={health.data.tip_time ?? null} />}
        <MineTicker />
        {page}
        <Footer />
        {mobile && <TabBar />}
        <WalletModal />
      </div>
    </AppContext.Provider>
  );
}
