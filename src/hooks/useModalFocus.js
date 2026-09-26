import { useEffect, useRef } from "react";

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one dialog behaviour shared by WalletModal and the buy sheet, so an
 * `aria-modal` container is never announced with focus stranded behind it:
 *
 *   - on open, remember the opener and move focus to the first focusable
 *     inside `ref` (skipping `skip` — the Close button — so a screen reader
 *     lands on the content), else the node itself (give it tabIndex={-1});
 *   - Tab / Shift+Tab cycle inside the node;
 *   - Escape calls `onClose` when one is given (pass null while a flow is
 *     in flight and the sheet may only be hidden from its own button);
 *   - body scroll is locked while open;
 *   - on close, focus returns to the opener.
 *
 * `onClose` is read through a ref: toggling it (busy ↔ idle) neither
 * re-runs the effect nor moves focus a second time.
 */
export function useModalFocus(ref, open, onClose, { skip = ".modal-close, .sheet-close" } = {}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const node = ref.current;
    if (!node || typeof document === "undefined") return undefined;
    const opener = document.activeElement;
    const focusables = () => Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    const first = focusables().find((el) => !el.matches(skip)) || focusables()[0];
    (first || node).focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (closeRef.current) {
          e.preventDefault();
          closeRef.current();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const head = f[0];
      const tail = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === head || !node.contains(active))) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (active === tail || !node.contains(active))) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, ref, skip]);
}
