import { LOGO_PATH } from "./logoPath";

// Syph mark: a nucleus with four spokes and eight tendrils, like a living cell.
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-104 -104 208 208" aria-hidden="true">
      <path d={LOGO_PATH} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <Mark size={20} />
      <span>syph</span>
    </span>
  );
}
