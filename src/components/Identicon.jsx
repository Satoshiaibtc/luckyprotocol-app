import { useMemo } from "react";
import { identiconData } from "../lib/identicon.js";

const GRID = 5;

/** Deterministic token avatar (sha256(ticker) → hue + symmetric 5×5 pattern). */
export default function Identicon({ ticker, size = 40, className = "" }) {
  const { hue, cells } = useMemo(() => identiconData(ticker), [ticker]);
  const cell = size / GRID;
  return (
    <svg
      className={`identicon ${className}`.trim()}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label={`${ticker} avatar`}
    >
      <rect width={size} height={size} fill={`hsl(${hue} 32% 14%)`} />
      {cells.map((on, i) =>
        on ? (
          <rect
            key={i}
            x={(i % GRID) * cell}
            y={Math.floor(i / GRID) * cell}
            width={cell}
            height={cell}
            fill={`hsl(${hue} 78% 62%)`}
          />
        ) : null,
      )}
    </svg>
  );
}
