import "../lib/cell-loader.js";

export type CellState = "idle" | "loading" | "streaming";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "cell-loader": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { state?: CellState; size?: string | number; "no-birth"?: string };
    }
  }
}

/** The Syph mark, alive: grows on mount, signals flow inward while loading and outward while streaming. */
export function CellLoader({ state, size, birth = true, className }: { state: CellState; size: number; birth?: boolean; className?: string }) {
  return <cell-loader state={state} size={size} className={className} {...(birth ? {} : { "no-birth": "" })} />;
}
