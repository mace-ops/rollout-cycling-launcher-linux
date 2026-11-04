// Die Oberfläche ist für 1280 × 800 (Steam Deck) entworfen und läuft bis herunter zu 1024 × 640.
const REF_W = 1280;
const REF_H = 800;
const MIN_W = 1024;
const MIN_H = 640;

/** Zoomfaktor: „auto“ passt die Größe an das Fenster an, sonst gilt der gewählte Wert, begrenzt auf das, was noch ins Fenster passt. Nie unter 1. */
export function zoomFor(scale: string, width: number, height: number): number {
  const max = Math.max(1, Math.min(width / MIN_W, height / MIN_H));
  const want = scale === 'auto' ? Math.min(width / REF_W, height / REF_H) : Number(scale) / 100;
  return Math.round(Math.min(Math.max(want, 1), max) * 100) / 100;
}
