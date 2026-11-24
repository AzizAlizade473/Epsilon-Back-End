/** Topographic rings from the Epsilon business card (port of the mobile app's contour.ts). */
const rings = 8;
const ringGap = 22;
const samples = 48;
const origins = [
  { x: 0.18, y: 0.28, phase: 0.4 },
  { x: 0.86, y: 0.52, phase: 2.1 },
  { x: 0.42, y: 1.02, phase: 4.3 },
];

function ring(cx: number, cy: number, radius: number, phase: number) {
  const pts = Array.from({ length: samples }, (_, i) => {
    const a = (i / samples) * Math.PI * 2;
    const w = 1 + 0.14 * Math.sin(3 * a + phase) + 0.07 * Math.sin(5 * a - phase * 1.7);
    return [cx + Math.cos(a) * radius * w, cy + Math.sin(a) * radius * w * 0.82] as const;
  });
  const mid = (a: readonly number[], b: readonly number[]) => `${((a[0]! + b[0]!) / 2).toFixed(1)} ${((a[1]! + b[1]!) / 2).toFixed(1)}`;
  let d = `M${mid(pts[samples - 1]!, pts[0]!)}`;
  pts.forEach((p, i) => {
    d += ` Q${p[0].toFixed(1)} ${p[1].toFixed(1)} ${mid(p, pts[(i + 1) % samples]!)}`;
  });
  return `${d} Z`;
}

export const contourPaths = (width: number, height: number): string[] =>
  origins.flatMap((o) => Array.from({ length: rings }, (_, i) => ring(o.x * width, o.y * height, ringGap * (i + 1), o.phase + i * 0.35)));
