const LLM_URL = process.env.VLLM_URL!;
const LLM_MODEL = process.env.VLLM_MODEL!;
const LLM_API_KEY = process.env.LLM_API_KEY!;

export type SentimentResult = {
  score: number;   // -1.0 (bearish) to 1.0 (bullish)
  summary: string; // one sentence rationale
};

export type SentimentArticle = {
  headline: string;
  publishedAt: Date;
  source?: string;
};

const SOURCE_TIERS: Record<string, number> = {
  Reuters: 3, Bloomberg: 3, "Associated Press": 3, "Dow Jones": 3,
  "Wall Street Journal": 3, "Financial Times": 3,
  CNBC: 2, MarketWatch: 2, "Barron's": 2, Forbes: 2, Fortune: 2,
  "Yahoo Finance": 1,
};

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
  return "";
}

export async function analyzeSentiment(
  ticker: string,
  articles: SentimentArticle[]
): Promise<SentimentResult> {
  const lines = articles
    .map((a, i) => `${i + 1}. [${ageLabel(a.publishedAt)}]${tierLabel(a.source)} ${a.headline}`)
    .join("\n");

  const prompt = `You are a financial sentiment analyst. Given the following news headlines about ${ticker}, return a JSON object with:
- "score": a float from -1.0 (very bearish) to 1.0 (very bullish), 0 being neutral
- "summary": one sentence explaining the overall sentiment

Weight more recent headlines more heavily. Headlines older than 3 days should have reduced influence unless they describe a major unresolved event. Consider materiality: regulatory actions and earnings surprises outweigh minor product announcements. Higher-authority sources (★★★ or ★★) should carry more weight than unrated sources.

Headlines:
${lines}

Respond with only valid JSON, no markdown.`;

  const res = await fetch(`${LLM_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    }),
  });

  if (!res.ok) throw new Error(`LLM error: ${res.status}`);

  const data = await res.json();
  const content = data.choices[0].message.content as string;

  return JSON.parse(content) as SentimentResult;
}
