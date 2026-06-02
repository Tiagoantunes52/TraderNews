/**
 * Pearson correlation coefficient between two equal-length series.
 * Returns null when there are fewer than `minPairs` points or either
 * series has zero variance (correlation undefined).
 */
export function pearson(xs: number[], ys: number[], minPairs = 5): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < minPairs) return null;

  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;

  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }

  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}
