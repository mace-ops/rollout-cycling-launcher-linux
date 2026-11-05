// The UI is designed for 1280 × 800 (Steam Deck) and runs down to 1024 × 640.
const REF_W = 1280;
const REF_H = 800;
const MIN_W = 1024;
const MIN_H = 640;

/** Zoom factor: "auto" adapts the size to the window, otherwise the chosen value applies, capped to what still fits in the window. Never below 1. */
export function zoomFor(scale: string, width: number, height: number): number {
  const max = Math.max(1, Math.min(width / MIN_W, height / MIN_H));
  const want = scale === 'auto' ? Math.min(width / REF_W, height / REF_H) : Number(scale) / 100;
  return Math.round(Math.min(Math.max(want, 1), max) * 100) / 100;
}
