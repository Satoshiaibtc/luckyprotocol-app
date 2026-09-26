import { useCallback, useMemo, useRef, useState } from "react";
import * as indexer from "./lib/indexer.js";
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
import UtxoSafetyNotice from "./components/UtxoSafetyNotice.jsx";
import Footer from "./components/Footer.jsx";
import Board from "./pages/Board.jsx";
import TokenPage from "./pages/TokenPage.jsx";
import CreatePage from "./pages/CreatePage.jsx";
import PortfolioPage from "./pages/PortfolioPage.jsx";

const MOCK = indexer.isMock();
const STATUS_POLL_MS = 15_000;

export default function App() {
  const { route, navigate } = useHashRoute();
  const w = useWallet();
  const mobile = useIsMobile();
  // The one wallet dialog (WalletModal): opened from the top bar and every ConnectPrompt.
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const openWalletModal = useCallback(() => setWalletModalOpen(true), []);
  const closeWalletModal = useCallback(() => setWalletModalOpen(false), []);

  // ---- app-wide indexer reads ----------------------------------------------------------
  const health = usePoll((s) => indexer.health(s), STATUS_POLL_MS, []);
  const tokens = usePoll((s) => indexer.tokens({ limit: 200 }, s), 30_000, []);
  const tipHeight = health.data?.tip_height ?? null;
  const fees = usePoll((s) => indexer.fees(s), 30_000, [tipHeight]);
  // One fee choice (preset from /fees or custom sat/vB) for every builder.
  const fee = useFeeRate(fees.error ? null : fees.data);
  const tipBlock = usePoll(tipHeight ? (s) => indexer.blockInfo(tipHeight, s) : null, 0, [tipHeight]);
  const indexerOk = !health.error && !!health.data;

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
      tipBlock,
      indexerOk,
      mock: MOCK,
      route,
      navigate,
      refreshAll,
    }),
    [w.wallet, w.connected, w.address, w.pubkeyHex, w.connect, w.disconnect, w.useMock, w.refreshBalance, walletModalOpen, openWalletModal, closeWalletModal, health, tokens, fees, fee, tipBlock, indexerOk, route, navigate, refreshAll],
  );

  let page;
  switch (route.name) {
    case "token":
      page = <TokenPage key={route.ticker} ticker={route.ticker} params={route.params} navigate={navigate} />;
      break;
    case "create":
      page = <CreatePage params={route.params} navigate={navigate} />;
      break;
    case "me":
      page = <PortfolioPage />;
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
        <MineTicker />
        <UtxoSafetyNotice />
        {page}
        <Footer />
        {mobile && <TabBar />}
        <WalletModal />
      </div>
    </AppContext.Provider>
  );
}
