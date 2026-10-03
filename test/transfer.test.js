// The Transfer action: the token page's Transfer tab (src/lib/tokenTabs.js
// and src/pages/TokenPage.jsx), the #/send and #/transfer routes
// (src/hooks/useHashRoute.js), and the wording of the transfer UI — its
// buttons, headings, tabs, aria labels, pending rows and activity labels
// say "Transfer", never "Send". The on-chain op keeps its name (SEND, and
// the "send" kind in code). Plain Node.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALL_TABS, TAB_LABEL, defaultTab, mintedOutFlipNotice, pinAfterPick, resolveTab, tabsFor } from "../src/lib/tokenTabs.js";
import { parseHash, sendHref, tokenHref } from "../src/hooks/useHashRoute.js";
import { KINDS, METRICS } from "../src/lib/activity.js";
import { ORDERS_INCOMPLETE_TEXT, sendAmountError, sendFormHint } from "../src/lib/send.js";
import { smallCarrierText } from "../src/lib/listingRules.js";
import { syncWarningText } from "../src/lib/sync.js";

const S = 21_000_000;
const token = (ticker, minted, extra = {}) => ({ ticker, supply: S, minted, minted_out: minted >= S, minted_out_height: minted >= S ? 970_186 : null, market_open: minted >= S, ...extra });
const closed = token("LUCKY", 1_234_567);
const opened = token("BLOK", S);
const pending = token("DUNE", S, { minted_out_height: 970_194, market_open: false, market_opens_at_height: 970_199 });

// ---- the tab list per token state --------------------------------------------------------------
{
  assert.ok(ALL_TABS.includes("transfer"));
  assert.equal(TAB_LABEL.transfer, "Transfer");
  assert.deepEqual(
    ALL_TABS.map((id) => TAB_LABEL[id]),
    ["Mine", "Market", "Transfer"],
    "every tab has a label",
  );
  assert.deepEqual(tabsFor(closed), ["mine", "transfer"], "before the market opens: Mine, then Transfer");
  assert.deepEqual(tabsFor(pending), ["mine", "transfer"], "minted out but not deep enough: still no Market tab");
  assert.deepEqual(tabsFor(opened), ["market", "mine", "transfer"], "market open: Market (the default), Mine, Transfer");
  assert.deepEqual(tabsFor(null), ["mine", "transfer"], "no token row yet");
  for (const t of [closed, pending, opened, null]) {
    assert.equal(tabsFor(t).at(-1), "transfer", "Transfer is always there, last");
    assert.notEqual(defaultTab(t), "transfer", "and never the default");
    assert.equal(tabsFor(t)[0], defaultTab(t), "the default comes first");
  }
  assert.equal(defaultTab(closed), "mine");
  assert.equal(defaultTab(opened), "market");
  console.log("transfer tabs: Mine | Transfer before the market opens, Market | Mine | Transfer after; the default is Mine, or Market once it is open");
}

// ---- ?tab=transfer and the other ?tab= values ---------------------------------------------------
{
  for (const t of [closed, pending, opened]) {
    assert.deepEqual(resolveTab("transfer", t.ticker, t), { tab: "transfer", notice: null }, `?tab=transfer opens the form (${t.ticker})`);
  }
  assert.deepEqual(resolveTab("transfer", "X", null), { tab: "transfer", notice: null }, "even before the token row is known");
  // absent, mine and market resolve to their tab; unknown values to the default
  assert.deepEqual(resolveTab(undefined, "LUCKY", closed), { tab: "mine", notice: null });
  assert.deepEqual(resolveTab(undefined, "BLOK", opened), { tab: "market", notice: null });
  assert.deepEqual(resolveTab("mine", "BLOK", opened), { tab: "mine", notice: null });
  assert.deepEqual(resolveTab("market", "BLOK", opened), { tab: "market", notice: null });
  for (const stale of ["buy", "sell", "send", "Transfer", ""]) {
    assert.deepEqual(resolveTab(stale, "LUCKY", closed), { tab: "mine", notice: null }, `?tab=${stale} → the default`);
    assert.deepEqual(resolveTab(stale, "BLOK", opened), { tab: "market", notice: null }, `?tab=${stale} → the default`);
  }
  const r = resolveTab("market", "LUCKY", closed);
  assert.equal(r.tab, "mine", "?tab=market before the market opens is still the console");
  assert.match(r.notice, /^Market opens when LUCKY is fully minted/);
  console.log("transfer ?tab=: transfer always resolves to the form; absent, mine and market resolve to their tab, unknown values to the default");
}

// ---- the pinned tab: the plain #/t/<TICKER> shows the default ----------------------------------------
{
  // Without ?tab= the page resolves the pinned tab (TokenPage: params.tab ?? pinned.tab).
  const plain = (pin, t) => resolveTab(pin?.tab, t.ticker, t).tab;
  const pinClosed = { tab: "mine", marketOpen: false };
  assert.equal(pinAfterPick(pinClosed, "transfer", closed), pinClosed, "a Transfer pick lives in ?tab= only");
  assert.equal(plain(pinAfterPick(pinClosed, "transfer", closed), closed), "mine", "Back from ?tab=transfer shows Mine");
  assert.deepEqual(pinAfterPick(pinClosed, "mine", closed), { tab: "mine", marketOpen: false }, "a pick of the default is pinned");
  const pinOpen = { tab: "market", marketOpen: true };
  for (const id of ["mine", "transfer"]) {
    assert.equal(plain(pinAfterPick(pinOpen, id, opened), opened), "market", `Back from ?tab=${id} shows Market`);
  }
  // A market that opened during the visit: the Mine pin and its notice hold
  // across a Transfer pick; Open Market pins Market with the first load's state.
  const flipped = { tab: "mine", marketOpen: false };
  assert.equal(plain(pinAfterPick(flipped, "transfer", opened), opened), "mine");
  assert.equal(mintedOutFlipNotice(pinAfterPick(flipped, "transfer", opened), opened), "BLOK is fully minted — its market is open.");
  assert.deepEqual(pinAfterPick(flipped, "market", opened), { tab: "market", marketOpen: false });
  assert.equal(plain(pinAfterPick(flipped, "market", opened), opened), "market");
  assert.equal(pinAfterPick(null, "transfer", closed), null);
  assert.deepEqual(pinAfterPick(null, "mine", closed), { tab: "mine", marketOpen: false });
  console.log("transfer pin: only a default pick is pinned, so Back to the plain URL shows Mine or Market, never Transfer");
}

// ---- routes: #/send, #/transfer (alias), the token page's deep link ------------------------------------------
{
  const utxo = `${"b".repeat(64)}:1`;
  for (const path of ["send", "transfer"]) {
    const r = parseHash(`#/${path}/lucky`);
    assert.deepEqual([r.name, r.ticker], ["send", "LUCKY"], `#/${path}/<TICKER> is the transfer page`);
    const s = parseHash(`#/${path}/ore?utxo=${encodeURIComponent(utxo)}&to=self`);
    assert.deepEqual([s.name, s.ticker, s.params.utxo, s.params.to], ["send", "ORE", utxo, "self"], `#/${path} keeps the split pre-selection`);
    assert.equal(parseHash(`#/${path}`).name, "notfound");
    assert.equal(parseHash(`#/${path}/bad-ticker!`).name, "notfound");
  }
  assert.equal(sendHref("ORE", { utxo, toSelf: true }), `#/send/ORE?utxo=${encodeURIComponent(utxo)}&to=self`, "the portfolio's Split link points at #/send");
  assert.equal(tokenHref("lucky", "transfer"), "#/t/LUCKY?tab=transfer");
  const deep = parseHash(`${tokenHref("ore", "transfer")}&utxo=${encodeURIComponent(utxo)}&to=self`);
  assert.deepEqual([deep.name, deep.ticker, deep.params.tab, deep.params.utxo, deep.params.to], ["token", "ORE", "transfer", utxo, "self"], "the Transfer tab reads the same split query");
  console.log("transfer routes: #/send and #/transfer → the transfer page; #/t/<TICKER>?tab=transfer[&utxo=…&to=self]");
}

// ---- the token page renders the transfer form of the #/send page ----------------------------------
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
// Comments go: they describe code, the scan is about what the UI shows.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
{
  const page = code(src("pages/TokenPage.jsx"));
  assert.match(page, /import SendPage from "\.\/SendPage\.jsx";/, "one transfer form, reused");
  assert.match(
    page,
    /const transfer = transferSeed && \(\s*<div hidden=\{tab !== "transfer"\}>\s*<SendPage key=\{`\$\{transferSeed\.utxo \|\| ""\}:\$\{transferSeed\.to \|\| ""\}`\} ticker=\{token\.ticker\} params=\{transferSeed\} embedded onSettled=\{onSettled\} \/>\s*<\/div>/,
    "once opened the form stays mounted, hidden on the other tabs; it reads the split query it opened with",
  );
  assert.match(page, /useState\(\(\) => \(params\.tab === "transfer" \? \{ utxo: params\.utxo, to: params\.to \} : null\)\)/, "a ?tab=transfer link opens the form on load");
  assert.match(page, /setTransferSeed\(\(s\) => \(!s \|\| \(params\.utxo && params\.utxo !== s\.utxo\) \? \{ utxo: params\.utxo, to: params\.to \} : s\)\)/, "a link to another carrier re-seeds the form");
  assert.ok(page.indexOf("const [transferSeed") < page.indexOf("if (notFound)"), "the form's state sits above the early returns");
  assert.match(page, /\{actionTabs\("seg"\)\}\s*\{transfer\}\s*\{tab === "market" \? market : tab === "transfer" \? null : mineConsole\}/, "phone: the form right after the tabs");
  assert.match(page, /\{actionTabs\("tabs"\)\}\s*\{transfer\}\s*\{tab === "market" \? \(\s*market\s*\) : tab === "transfer" \? null : \(/, "desktop: the same slot, so a layout switch keeps it mounted");
  assert.match(
    page,
    /const setTab = \(id\) => \{\s*if \(id === "transfer" && tab === "transfer"\) return;\s*if \(id === "transfer"\) setTransferSeed\(\(s\) => s \|\| \{\}\);\s*setPinned\(\(p\) => pinAfterPick\(p, id, token\)\);/,
    "the active Transfer tab never navigates (a split link keeps its query); a pick opens the form; only a default pick is pinned",
  );
  const send = code(src("pages/SendPage.jsx"));
  assert.match(send, /export default function SendPage\(\{ ticker, params = \{\}, embedded = false, onSettled = null \}\)/);
  assert.match(send, /const Shell = embedded \? "div" : "main";/, "embedded: no second <main> inside the token page");
  assert.match(send, /\{!embedded && \(\s*<header className="token-head">/, "embedded: no page header");
  assert.match(send, /\{!embedded && <Identicon ticker=\{ticker\} size=\{48\} \/>\}\s*\{!embedded && <h2>Transfer \{ticker\}<\/h2>\}/, "embedded, not connected: no second identicon or title");
  assert.match(
    send,
    /right=\{embedded \? <span className="label">\{tokenUtxos\.data \? `\$\{fmtInt\(total\)\} \$\{ticker\} on \$\{fmtInt\(rows\.length\)\} carrier\$\{rows\.length === 1 \? "" : "s"\}` : tokenUtxos\.error \? "—" : "Loading…"\}<\/span> : undefined\}/,
    "embedded: the holdings line moves into the form's panel head",
  );
  assert.match(send, /useSendToSelf\(\{\s*onSettled: \(\) => \{[^}]*\bonSettled\?\.\(\);[^}]*\}/, "a settled transfer refreshes the token page");
  // No holdings of the ticker: one line and a way on, not the form.
  const iConnect = send.indexOf("if (!connected)");
  const iEmpty = send.indexOf('if (tokenUtxos.data && rows.length === 0 && pendingSends.length === 0 && chain.phase === "idle")');
  assert.ok(iConnect > 0 && iEmpty > iConnect && iEmpty < send.indexOf("<Panel"), "the no-holdings state comes after the connect prompt, before the form");
  assert.match(send.slice(iEmpty), /^[^\n]*\{\s*return \(\s*<Shell className=\{shellClass\}>\s*<TransferEmpty ticker=\{ticker\} embedded=\{embedded\} \/>\s*<\/Shell>/);
  const empty = code(src("components/TransferEmpty.jsx"));
  assert.match(empty, /<p className="muted">You hold no \{ticker\} on this address\.<\/p>/);
  assert.match(empty, /\{!embedded && <Identicon ticker=\{ticker\} size=\{48\} \/>\}\s*\{!embedded && <h2>Transfer \{ticker\}<\/h2>\}/, "embedded: the token page header names the token");
  assert.match(empty, /\{embedded \? \(\s*<a className="btn" href=\{tokenHref\(ticker\)\}>\s*Back to \{ticker\}\s*<\/a>/, "embedded: back to the default tab");
  assert.match(empty, /href="#\/me">\s*← Portfolio\s*<\/a>[\s\S]*href=\{tokenHref\(ticker\)\}>\s*\{ticker\} page\s*<\/a>/, "the #/send page: the portfolio and the token page");
  const app = code(src("App.jsx"));
  assert.match(app, /case "send":\s*page = <SendPage (?![^>]*\bembedded\b)/, "#/send and #/transfer render the full page");
  console.log("transfer tab: TokenPage embeds SendPage (no shell, no header) on phone and desktop");
}

// ---- wording: Transfer, never Send, for this action ---------------------------------------------------
{
  // Where the transfer action is shown: its form, the token page's tabs,
  // the portfolio's per-token button, the activity ledger's labels.
  const FILES = ["pages/SendPage.jsx", "components/TransferEmpty.jsx", "lib/send.js", "pages/TokenPage.jsx", "lib/tokenTabs.js", "pages/PortfolioPage.jsx", "lib/activity.js", "components/Tables.jsx", "pages/ActivityPage.jsx", "hooks/useSendToSelf.js", "lib/sync.js"];
  const hits = [];
  for (const f of FILES) {
    // Code that is not text: the "send" kind and "sends" metric ids, object
    // keys and fields (`send:`, `row.sends`), class names and ids
    // ("send-grid", "bal-send"), the lib's path, the Speed up prop.
    const text = code(src(f))
      .replace(/(["'])sends?\1/g, "")
      .replace(/\bsends?:/g, "")
      .replace(/\.sends?\b/g, "")
      .replace(/\bsend-[a-z]|-send\b/g, "")
      .replace(/\/send\.js\b/g, "")
      .replace(/\bsend=\{/g, "");
    text.split("\n").forEach((line, i) => {
      const m = line.match(/\b(Send|Sends|Sending|Sent)\b/) || line.match(/\b(send|sends|sending)\b/);
      if (m) hits.push(`src/${f}:${i + 1}: "${m[0]}" in ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], `the transfer UI still says "send":\n  ${hits.join("\n  ")}`);

  const send = src("pages/SendPage.jsx");
  assert.match(send, /<h1 className="ticker">Transfer \{ticker\}<\/h1>/, "page heading");
  assert.match(send, /<h2>Transfer \{ticker\}<\/h2>/, "connect prompt heading");
  assert.match(send, /<ConnectPrompt action=\{`transfer \$\{ticker\}`\} \/>/);
  assert.match(send, /Transfer <strong>\{fmtInt\(review\.amount\)\} \{ticker\}<\/strong> to/, "review summary");
  assert.match(send, /Sign with \{w\.providerName \|\| "your wallet"\} · transfer \{fmtInt\(amount \?\? 0\)\} \{ticker\}/, "sign button");
  assert.match(send, /\? "Split" : "Transfer"\} broadcast\./, "pending line — Split stays Split");
  assert.match(send, /title=\{`Your unconfirmed \$\{ticker\} transfers`\} led="busy" aria-label="Unconfirmed transfers"/, "pending rows");
  assert.match(send, /Split off/, "the split keeps its name");
  const portfolio = src("pages/PortfolioPage.jsx");
  assert.match(portfolio, /aria-label=\{`Transfer \$\{ticker\}`\}>\s*Transfer\s*<\/a>/, "the portfolio's per-token button");
  assert.match(portfolio, /Split off \{tk\}/, "the portfolio's split links keep their name");
  assert.match(src("components/Tables.jsx"), /const KIND_LABEL = \{ deploy: "Deploy", mine: "Mine", send: "Transfer", trade: "Trade" \};/, "the ledger's kind tag");
  assert.match(src("pages/ActivityPage.jsx"), /<dt>Transfers · 30d<\/dt>/);
  assert.equal(KINDS.find((k) => k.id === "send").label, "Transfer", "the ledger filter (id stays send)");
  assert.equal(METRICS.find((m) => m.id === "sends").label, "Transfers", "the daily chart metric (id stays sends)");
  assert.match(src("hooks/useSendToSelf.js"), /const WHAT = \{ cancel: "withdrawal", split: "split", send: "transfer" \};/, "messages say \"this transfer\"");

  assert.match(src("pages/SendPage.jsx"), /missingFeeHint\(fee\.choice, fee\.satVb, "transfer", /, "the form's fee hint says transfer");
  assert.match(src("hooks/useSendToSelf.js"), /kind === "send" \? "transfer" : "split"/, "the fee-rate error says transfer");
  // The ledger: its empty text is built from the chip's label; its subtitle and not-applied tag name a transfer.
  const activity = src("pages/ActivityPage.jsx");
  assert.match(activity, /`No \$\{\(KINDS\.find\(\(k\) => k\.id === kind\)\?\.label \?\? kind\)\.toLowerCase\(\)\} rows yet\.`/, "the empty ledger names the chip");
  assert.equal(`No ${KINDS.find((k) => k.id === "send").label.toLowerCase()} rows yet.`, "No transfer rows yet.");
  assert.match(activity, /every DEPLOY, MINE, TRANSFER and fill the indexer has applied · a fill is a transfer and a trade/);
  assert.match(src("components/Tables.jsx"), /"The indexer did not apply this transfer \(amount shown is what it asked for\)\."/);
  // The site banner names the paused action the way the form does.
  assert.match(syncWarningText({ indexed: 1, tip: 2, lag: 1, stalled: true, rebuilding: false, noPeers: false, networkLag: 0, synced: false }), /Creating, mining, transferring, listing and buying are paused/);
  // Listing help that moves the tokens to yourself names the Transfer action.
  assert.match(smallCarrierText(330), /\(a transfer to yourself\)/);
  assert.match(src("lib/listingRules.js"), /note: "spent on-chain without a fill \(a withdrawal, a split or a transfer\)"/);
  for (const f of ["components/SellPanel.jsx", "lib/market.js", "lib/indexer.js", "lib/swap.js"]) {
    assert.doesNotMatch(src(f), /\b[Aa] send to yourself\b/, `${f}: "a transfer to yourself"`);
  }

  // the form's own hints
  assert.equal(sendFormHint({ connected: true, indexerOk: false }), "The indexer is not answering right now — transfers are paused until it does.");
  assert.equal(sendFormHint({ connected: true, indexerOk: true, lagText: null, rcptState: "ok", amount: null, amountErr: null, ticker: "LUCKY" }), "Enter how many LUCKY to transfer.");
  assert.equal(sendAmountError("5", 0, "LUCKY"), "No LUCKY available to transfer right now.");
  assert.match(ORDERS_INCOMPLETE_TEXT, /tick the ones to transfer/);
  console.log("transfer wording: buttons, headings, tabs, aria labels, pending rows and activity labels say Transfer; Split stays Split");
}
