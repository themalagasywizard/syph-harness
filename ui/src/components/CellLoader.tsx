import { useEffect, useRef } from "react";
import "../lib/cell-loader.js";

export type CellState = "idle" | "loading" | "streaming";

type CellElement = HTMLElement & { pulse?: () => void; settle?: () => void };

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "cell-loader": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { state?: CellState; size?: string | number; "no-birth"?: string; settle?: string; bare?: string };
    }
  }
}

/**
 * The Syph mark, alive: grows on mount, swims while thinking and streaming, and
 * springs back into the exact mark when a reply ends.
 * `beat` changes on every streamed chunk (for example the text length) and makes the nucleus beat.
 * `settle` mounts mid-swim and springs back into shape; use it for a reply that has just finished.
 * `bare` hides the outer membrane/orbital ring so only the living logo renders at any size.
 */
export function CellLoader({ state, size, birth = true, settle = false, bare = false, beat, className }: { state: CellState; size: number; birth?: boolean; settle?: boolean; bare?: boolean; beat?: number; className?: string }) {
  const ref = useRef<CellElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (beat !== undefined) ref.current?.pulse?.();
  }, [beat]);
  return <cell-loader ref={ref} state={state} size={size} className={className} {...(birth ? {} : { "no-birth": "" })} {...(settle ? { settle: "" } : {})} {...(bare ? { bare: "" } : {})} />;
}
