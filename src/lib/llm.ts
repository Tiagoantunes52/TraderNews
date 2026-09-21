const LLM_URL = process.env.VLLM_URL!;
const LLM_MODEL = process.env.VLLM_MODEL!;
const LLM_API_KEY = process.env.LLM_API_KEY!;

// Per-call ceiling. Sized to the configured model, NOT to a round number: at
// 30s this sat exactly on Nemotron 3 Ultra's median latency, so from 2026-09-01
// (Super -> Ultra) every ticker became a coin flip — 34% landed, the rest aborted
// and were retried, and the sentiment stage stretched from 1 poll to 21.
//
// INVARIANT: a stage's budget + this timeout must stay under the pipeline routes'
// `maxDuration` (300s). `processWithBudget` stops *scheduling* at its deadline but
// lets in-flight calls run on, so an invocation's true ceiling is the sum — and if
// it trips, Vercel kills the invocation and the whole slice is lost, not just the
// slow call. Pinned by a test alongside SENTIMENT_BUDGET_MS; raise one and the
// other has to give.
export const REQUEST_TIMEOUT_MS = 60_000;

// Aspect-level breakdown lets us see *why* a score landed where it did, and lets
// the UI and downstream weighting distinguish material drivers (earnings,
// regulatory) from noise (routine product news).
export type SentimentAspect = { score: number; weight: number };

export type SentimentResult = {
  score: number;      // -1.0 (bearish) to 1.0 (bullish)
  confidence: number; // 0.0 (guessing) to 1.0 (high conviction)
  summary: string;    // one sentence rationale
  keyDriver: string | null;
  timeHorizon: "near_term" | "medium" | "long" | null;
  aspects: Record<string, SentimentAspect>;
};

export type SentimentArticle = {
  headline: string;
  summary?: string | null;
  publishedAt: Date;
  source?: string;
};

const SOURCE_TIERS: Record<string, number> = {
  Reuters: 3, Bloomberg: 3, "Associated Press": 3, "Dow Jones": 3,
  "Wall Street Journal": 3, "Financial Times": 3,
  CNBC: 2, MarketWatch: 2, "Barron's": 2, Forbes: 2, Fortune: 2,
  "Yahoo Finance": 1,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function ageLabel(publishedAt: Date): string {
  const diffMs = Date.now() - publishedAt.getTime();
  const diffH = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffH < 1) return "just now";
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

function tierLabel(source?: string): string {
  if (!source) return "";
  const tier = SOURCE_TIERS[source] ?? 0;
  if (tier === 3) return " [★★★]";
  if (tier === 2) return " [★★]";
  if (tier === 1) return " [★]"; // mark known tier-1 so it's distinct from unknown
  return "";
}

const VALID_HORIZONS = new Set(["near_term", "medium", "long"]);

// A neutral, low-confidence result. Used when the model returns something we
// can't parse — better than dropping the day's reading entirely, and the low
// confidence keeps it from moving downstream estimates much.
function neutralFallback(summary = "Could not parse model response."): SentimentResult {
  return { score: 0, confidence: 0.1, summary, keyDriver: null, timeHorizon: null, aspects: {} };
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseAspects(raw: unknown): Record<string, SentimentAspect> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, SentimentAspect> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const score = toFiniteNumber((val as Record<string, unknown>).score);
    if (score == null) continue;
    const weight = toFiniteNumber((val as Record<string, unknown>).weight);
    out[key] = { score: clamp(score, -1, 1), weight: clamp(weight ?? 0, 0, 1) };
  }
  return out;
}

/**
 * Parse the model's chat completion content into a SentimentResult.
 * Tolerant by design: strips markdown fences, clamps out-of-range values,
 * coerces numeric strings, and falls back to neutral/low-confidence on any
 * structural failure instead of throwing.
 */
export function parseSentimentResponse(content: string): SentimentResult {
  if (!content || !content.trim()) return neutralFallback("Empty model response.");

  // Strip ```json ... ``` or ``` ... ``` fences some models add despite instructions.
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  // If there's leading/trailing prose, grab the outermost JSON object.
  if (!text.startsWith("{")) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) text = text.slice(first, last + 1);
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return neutralFallback();
  }
  if (!obj || typeof obj !== "object") return neutralFallback();

  const score = toFiniteNumber(obj.overall_score ?? obj.score);
  if (score == null) return neutralFallback("Model response missing a numeric score.");

  const confidence = toFiniteNumber(obj.confidence);
  const horizon = typeof obj.time_horizon === "string" && VALID_HORIZONS.has(obj.time_horizon)
    ? (obj.time_horizon as SentimentResult["timeHorizon"])
    : null;
  const keyDriver = typeof obj.key_driver === "string" && obj.key_driver.trim()
    ? obj.key_driver.trim()
    : null;
  const summary = typeof obj.summary === "string" && obj.summary.trim()
    ? obj.summary.trim()
    : keyDriver ?? "No summary provided.";

  return {
    score: clamp(score, -1, 1),
    confidence: confidence == null ? 0.3 : clamp(confidence, 0, 1),
    summary,
    keyDriver,
    timeHorizon: horizon,
    aspects: parseAspects(obj.aspects),
  };
}

const SYSTEM_PROMPT = `You are a sell-side-grade financial news analyst. You assess the directional sentiment of news for a SPECIFIC stock — not its sector or the broad market.

Rules:
- Judge impact on the named ticker only. "Sector rallies" is weak signal for one name; a company-specific earnings beat is strong.
- Distinguish forward-looking signals (guidance, analyst rating/price-target changes, M&A, regulatory actions) from backward-looking ones (already-reported results). Forward-looking and unresolved events matter more.
- Weight material events (earnings surprises, regulatory/legal actions, guidance changes, analyst actions) far above routine product, marketing, or partnership news.
- Weight more recent headlines and higher-tier sources (★★★ > ★★ > ★ > unrated) more heavily. Headlines older than ~3 days carry little weight unless they describe a major unresolved event.
- If coverage is thin, stale, or contradictory, LOWER your confidence rather than guessing.

Respond with ONLY a JSON object (no markdown, no prose) of this exact shape:
{
  "overall_score": <float -1.0..1.0>,
  "confidence": <float 0.0..1.0>,
  "time_horizon": "near_term" | "medium" | "long",
  "key_driver": "<the single most important article/event, one short phrase>",
  "summary": "<one sentence explaining the overall sentiment>",
  "aspects": {
    "earnings_results":   {"score": <-1..1>, "weight": <0..1>},
    "guidance_outlook":   {"score": <-1..1>, "weight": <0..1>},
    "analyst_actions":    {"score": <-1..1>, "weight": <0..1>},
    "regulatory_legal":   {"score": <-1..1>, "weight": <0..1>},
    "product_operations": {"score": <-1..1>, "weight": <0..1>}
  }
}
Only include aspects that the headlines actually touch on; omit the rest. Weights are how much each aspect drove your overall score and should reflect materiality.`;

function buildUserPrompt(ticker: string, articles: SentimentArticle[]): string {
  const lines = articles
    .map((a, i) => {
      const head = `${i + 1}. [${ageLabel(a.publishedAt)}]${tierLabel(a.source)} ${a.headline}`;
      const summary = a.summary?.trim();
      return summary ? `${head}\n   — ${summary.slice(0, 280)}` : head;
    })
    .join("\n");

  return `Ticker: ${ticker}\n\nNews (headline, with summary where available):\n${lines}`;
}

// Carries the HTTP status so the retry predicate can tell a transient 5xx from
// a permanent 4xx (bad key, malformed request) that no retry will fix.
export class LlmHttpError extends Error {
  constructor(readonly status: number) {
    super(`LLM error: ${status}`);
    this.name = "LlmHttpError";
  }
}

// Whether a failed LLM call is worth a second attempt.
//
// The decisive case is the abort: a request we cancelled after REQUEST_TIMEOUT_MS
// because the endpoint never answered. Retrying that is the worst trade in the
// pipeline — it is the least likely to succeed (the endpoint is overloaded, not
// flaky) and the most expensive, doubling a timeout's cost from 30s to 60s of
// wall clock inside a 240s stage budget. On 2026-09-13 that doubling burned ~65
// of run #861's 99 minutes. Everything else here fails fast, so a retry is cheap.
export function isRetriableLlmError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return false;
  if (e instanceof LlmHttpError) return e.status >= 500 || e.status === 429;
  return true; // transport/DNS/socket errors: fast to fail, often transient
}

async function callLlm(prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${LLM_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new LlmHttpError(res.status);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content as string) ?? "";
  } finally {
    clearTimeout(timer);
  }
}

export async function analyzeSentiment(
  ticker: string,
  articles: SentimentArticle[]
): Promise<SentimentResult> {
  const prompt = buildUserPrompt(ticker, articles);

  // One retry, but only for failures a retry can plausibly fix — see
  // isRetriableLlmError. Timeouts are rethrown immediately rather than doubled.
  // A response that parses badly is handled by parseSentimentResponse.
  let content: string;
  try {
    content = await callLlm(prompt);
  } catch (e) {
    if (!isRetriableLlmError(e)) throw e; // surfaces to the pipeline's per-stock catch
    content = await callLlm(prompt); // surfaces to the same catch if it throws again
  }

  return parseSentimentResponse(content);
}
