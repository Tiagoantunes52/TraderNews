const LLM_URL = process.env.VLLM_URL!;
const LLM_MODEL = process.env.VLLM_MODEL!;
const LLM_API_KEY = process.env.LLM_API_KEY!;

export type SentimentResult = {
  score: number;   // -1.0 (bearish) to 1.0 (bullish)
  summary: string; // one sentence rationale
};

export async function analyzeSentiment(
  ticker: string,
  headlines: string[]
): Promise<SentimentResult> {
  const prompt = `You are a financial sentiment analyst. Given the following news headlines about the stock ${ticker}, return a JSON object with:
- "score": a float from -1.0 (very bearish) to 1.0 (very bullish), 0 being neutral
- "summary": one sentence explaining the overall sentiment

Headlines:
${headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}

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
