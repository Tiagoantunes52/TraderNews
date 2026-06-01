export type YahooRssArticle = {
  title: string;
  url: string;
  publishedAt: Date;
  description: string | null;
};

// Handles both <tag><![CDATA[...]]></tag> and plain <tag>text</tag>
function extractText(fragment: string, tag: string): string | null {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`,
    "i"
  );
  const m = fragment.match(re);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").trim() || null;
}

export async function getYahooRssNews(ticker: string): Promise<YahooRssArticle[]> {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Yahoo RSS error: ${res.status} — ${body}`);
  }

  const xml = await res.text();
  const articles: YahooRssArticle[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRe.exec(xml)) !== null) {
    const item = match[1];
    const title = extractText(item, "title");
    const link = extractText(item, "link");
    const pubDate = extractText(item, "pubDate");
    const description = extractText(item, "description");

    if (!title || !link) continue;
    articles.push({
      title,
      url: link,
      publishedAt: pubDate ? new Date(pubDate) : new Date(),
      description: description || null,
    });
  }

  return articles;
}
