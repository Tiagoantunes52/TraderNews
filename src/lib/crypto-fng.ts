// Crypto Fear & Greed Index (alternative.me) — free, keyless. A market-wide
// 0–100 crypto sentiment gauge we blend into per-coin sentiment, the same way
// Alpha Vantage's per-article sentiment is blended for equities.

const FNG_URL = "https://api.alternative.me/fng/";

export type FearGreed = {
  value: number; // 0–100
  classification: string; // e.g. "Extreme Fear", "Greed"
  timestamp: Date;
  score: number; // normalized to [-1, 1]
};

/** 0 (extreme fear) → -1, 50 (neutral) → 0, 100 (extreme greed) → +1. */
export function fngToScore(value: number): number {
  return Math.max(-1, Math.min(1, (value - 50) / 50));
}

export async function getCryptoFearGreed(): Promise<FearGreed | null> {
  const res = await fetch(`${FNG_URL}?limit=1`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fear & Greed error: ${res.status}`);

  const data = (await res.json()) as {
    data?: Array<{ value: string; value_classification: string; timestamp: string }>;
  };
  const latest = data.data?.[0];
  if (!latest) return null;

  const value = parseInt(latest.value, 10);
  if (Number.isNaN(value)) return null;

  return {
    value,
    classification: latest.value_classification,
    timestamp: new Date(parseInt(latest.timestamp, 10) * 1000),
    score: fngToScore(value),
  };
}
