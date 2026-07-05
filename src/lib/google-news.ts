// Google News RSS — keyless, global news search keyed by company name.
//
// This is the coverage workhorse for non-US (European) tickers, which the
// US-centric providers (Finnhub, Alpha Vantage) don't cover and Yahoo RSS
// returns next to nothing for. We search Google News in the stock's *local*
// locale (pt-PT for Lisbon, de-DE for XETRA, …) so we pick up the local-language
// outlets where European stock news actually lives (Jornal de Negócios, ECO,
// Handelsblatt, Cinco Días, …).
//
// EU consent wall: Google 302-redirects regional requests to a consent page.
// Sending `Cookie: CONSENT=YES+` and a browser User-Agent returns the RSS
// directly.

import { fetchWithRetry } from "@/lib/http";

export type GoogleNewsArticle = {
  title: string;
  url: string;
  publishedAt: Date;
  source: string; // publisher name parsed from the <source> element
};

type Locale = { hl: string; gl: string; lang: string };

// Exchange suffix → Google News locale. Order matters: ".LS" must be checked
// before ".L" (both are suffixes of a Lisbon ticker's tail otherwise).
const LOCALE_BY_SUFFIX: Array<[string, Locale]> = [
  [".LS", { hl: "pt-PT", gl: "PT", lang: "pt" }], // Euronext Lisbon
  [".PA", { hl: "fr-FR", gl: "FR", lang: "fr" }], // Euronext Paris
  [".DE", { hl: "de-DE", gl: "DE", lang: "de" }], // XETRA
  [".AS", { hl: "nl-NL", gl: "NL", lang: "nl" }], // Euronext Amsterdam
  [".MC", { hl: "es-ES", gl: "ES", lang: "es" }], // BME (Madrid)
  [".MI", { hl: "it-IT", gl: "IT", lang: "it" }], // Borsa Italiana
  [".L", { hl: "en-GB", gl: "GB", lang: "en" }], // London Stock Exchange
];
const DEFAULT_LOCALE: Locale = { hl: "en-US", gl: "US", lang: "en" };

export function localeForTicker(ticker: string): Locale {
  for (const [suffix, loc] of LOCALE_BY_SUFFIX) {
    if (ticker.endsWith(suffix)) return loc;
  }
  return DEFAULT_LOCALE;
}

const tidy = (s: string) =>
  s
    .replace(/[—–]/g, " ") // em/en dashes → space (keep real hyphens like Mota-Engil)
    .replace(/\s+/g, " ")
    .trim();

/**
 * Build the Google News `q` value from a stored company name. The parenthetical
 * is often the *common* name (e.g. "… (Inditex)", "… (BBVA)"), so we search the
 * formal name OR the alias rather than dropping either. Phrases are quoted; the
 * caller appends the `when:` window.
 */
export function googleNewsQuery(name: string): string {
  const aliases: string[] = [];
  const parenRe = /\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = parenRe.exec(name)) !== null) {
    const alias = tidy(m[1]);
    if (alias.length >= 2) aliases.push(alias);
  }
  const main = tidy(name.replace(/\([^)]*\)/g, " "));
  const terms = [...new Set([main, ...aliases].filter((t) => t.length >= 2))];
  return terms.map((t) => `"${t}"`).join(" OR ");
}

// Handles both <tag><![CDATA[...]]></tag> and plain <tag …>text</tag>.
function extractText(fragment: string, tag: string): string | null {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`,
    "i"
  );
  const m = fragment.match(re);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").trim() || null;
}

/** Parse a Google News RSS document, keeping only items at or after `since`. */
export function parseGoogleNewsRss(xml: string, since: Date): GoogleNewsArticle[] {
  const out: GoogleNewsArticle[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const item = match[1];
    const link = extractText(item, "link");
    let title = extractText(item, "title");
    const pubDate = extractText(item, "pubDate");
    const publisher = extractText(item, "source");
    if (!link || !title) continue;

    const publishedAt = pubDate ? new Date(pubDate) : new Date();
    if (Number.isNaN(publishedAt.getTime()) || publishedAt < since) continue;

    // Google appends " - Publisher" to every title; strip it for a clean headline.
    if (publisher && title.endsWith(` - ${publisher}`)) {
      title = title.slice(0, title.length - (publisher.length + 3)).trim();
    }
    out.push({ title, url: link, publishedAt, source: publisher ?? "Google News" });
  }
  return out;
}

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Fetch local-locale Google News for one company, published since `since`. */
export async function getGoogleNews(name: string, ticker: string, since: Date): Promise<GoogleNewsArticle[]> {
  const query = googleNewsQuery(name);
  if (query.length < 2) return [];
  return searchGoogleNews(query, since, localeForTicker(ticker));
}

/**
 * Fetch Google News RSS for a prebuilt query string (the ticker-oriented
 * `getGoogleNews` above and the private-company watch both funnel through here).
 */
export async function searchGoogleNews(
  query: string,
  since: Date,
  loc: Locale = DEFAULT_LOCALE
): Promise<GoogleNewsArticle[]> {
  const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86_400_000));

  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", `${query} when:${days}d`);
  url.searchParams.set("hl", loc.hl);
  url.searchParams.set("gl", loc.gl);
  url.searchParams.set("ceid", `${loc.gl}:${loc.lang}`);

  const res = await fetchWithRetry(url.toString(), {
    headers: {
      "User-Agent": BROWSER_UA,
      Cookie: "CONSENT=YES+", // bypass the EU consent redirect
      Accept: "application/rss+xml, application/xml, text/xml",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google News error: ${res.status} — ${body.slice(0, 200)}`);
  }

  return parseGoogleNewsRss(await res.text(), since);
}
