import { useCallback, useMemo, useRef } from "react";
import * as indexer from "./lib/indexer.js";
import { usePoll } from "./hooks/usePoll.js";
import { useWallet } from "./hooks/useWallet.js";
import { useHashRoute } from "./hooks/useHashRoute.js";
import { useIsMobile } from "./hooks/useMediaQuery.js";
import { AppContext } from "./context.js";
import TopBar from "./components/TopBar.jsx";
import TabBar from "./components/TabBar.jsx";
import MineTicker from "./components/MineTicker.jsx";
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

  // ---- app-wide indexer reads ----------------------------------------------------------
  const health = usePoll((s) => indexer.health(s), STATUS_POLL_MS, []);
  const tokens = usePoll((s) => indexer.tokens({ limit: 200 }, s), 30_000, []);
  const fees = usePoll((s) => indexer.fees(s), 60_000, []);
  const tipHeight = health.data?.tip_height ?? null;
  const tipBlock = usePoll(tipHeight ? (s) => indexer.blockInfo(tipHeight, s) : null, 0, [tipHeight]);
  const indexerOk = !health.error && !!health.data;

  // Stable "refresh everything" handle for flows that settle on-chain.
  const refreshAllRef = useRef(null);
  refreshAllRef.current = () => {
    health.refresh();
    tokens.refresh();
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
      health,
      tokens,
      fees,
      tipBlock,
      indexerOk,
      mock: MOCK,
      route,
      navigate,
      refreshAll,
    }),
    [w.wallet, w.connected, w.address, w.pubkeyHex, w.connect, w.disconnect, w.useMock, w.refreshBalance, health, tokens, fees, tipBlock, indexerOk, route, navigate, refreshAll],
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
        {page}
        <Footer />
        {mobile && <TabBar />}
      </div>
    </AppContext.Provider>
  );
}
