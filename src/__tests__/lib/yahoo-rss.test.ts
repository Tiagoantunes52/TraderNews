import { describe, it, expect, afterEach, vi } from "vitest";
import { getYahooRssNews } from "@/lib/yahoo-rss";

afterEach(() => vi.unstubAllGlobals());

const rss = (items: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel>${items}</channel></rss>`;

const item = (title: string, link: string, pubDate: string, description = "") => `
<item>
  <title>${title}</title>
  <link>${link}</link>
  <pubDate>${pubDate}</pubDate>
  ${description ? `<description>${description}</description>` : ""}
</item>`;

const cdataItem = (title: string, link: string, pubDate: string, description = "") => `
<item>
  <title><![CDATA[${title}]]></title>
  <link>${link}</link>
  <pubDate>${pubDate}</pubDate>
  ${description ? `<description><![CDATA[${description}]]></description>` : ""}
</item>`;

describe("getYahooRssNews()", () => {
  it("parses plain-text RSS items", async () => {
    const xml = rss(item("Apple Up 2%", "https://finance.yahoo.com/a", "Mon, 02 Jun 2025 10:00:00 +0000", "A rose."));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => xml }));

    const articles = await getYahooRssNews("AAPL");
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Apple Up 2%");
    expect(articles[0].url).toBe("https://finance.yahoo.com/a");
    expect(articles[0].description).toBe("A rose.");
  });

  it("parses CDATA-wrapped title and description", async () => {
    const xml = rss(cdataItem("Apple & <Earnings>", "https://finance.yahoo.com/b", "Mon, 02 Jun 2025 11:00:00 +0000", "Beat by <b>3%</b>."));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => xml }));

    const articles = await getYahooRssNews("AAPL");
    expect(articles[0].title).toBe("Apple & <Earnings>");
    expect(articles[0].description).toBe("Beat by <b>3%</b>.");
  });

  it("sets description to null when absent", async () => {
    const xml = rss(item("No Description", "https://finance.yahoo.com/c", "Mon, 02 Jun 2025 12:00:00 +0000"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => xml }));

    const articles = await getYahooRssNews("AAPL");
    expect(articles[0].description).toBeNull();
  });

  it("skips items with missing title or link", async () => {
    const xml = rss(`
      <item><link>https://finance.yahoo.com/d</link></item>
      <item><title>Has Title But No Link</title></item>
      ${item("Valid", "https://finance.yahoo.com/e", "Mon, 02 Jun 2025 13:00:00 +0000")}
    `);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => xml }));

    const articles = await getYahooRssNews("AAPL");
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Valid");
  });

  it("returns empty array for empty feed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => rss("") }));
    expect(await getYahooRssNews("AAPL")).toEqual([]);
  });

  it("throws on non-ok HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "not found" }));
    await expect(getYahooRssNews("AAPL")).rejects.toThrow("Yahoo RSS error: 404");
  });
});
