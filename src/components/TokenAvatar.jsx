import { useEffect, useState } from "react";
import Identicon from "./Identicon.jsx";
import * as indexer from "../lib/indexer.js";

/**
 * A token's picture: the on-chain avatar (spec §8) when the token row
 * carries `avatar_txid`, loaded from the indexer's
 * `/tokens/:ticker/avatar?v=<txid>` (a `data:` URL in mock mode); the
 * deterministic identicon otherwise, and again if the image fails to load.
 */
export default function TokenAvatar({ ticker, avatarTxid = null, size = 40, className = "" }) {
  const src = avatarTxid ? indexer.avatarUrl(ticker, avatarTxid) : null;
  const [failedSrc, setFailedSrc] = useState(null);
  useEffect(() => {
    setFailedSrc(null);
  }, [src]);
  if (!src || failedSrc === src) return <Identicon ticker={ticker} size={size} className={className} />;
  return (
    <img
      className={`token-avatar ${className}`.trim()}
      src={src}
      width={size}
      height={size}
      alt={`${ticker} avatar`}
      decoding="async"
      loading="lazy"
      onError={() => setFailedSrc(src)}
    />
  );
}
