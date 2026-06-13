import { describe, it, expect } from "vitest";
import { localeForTicker, googleNewsQuery, parseGoogleNewsRss } from "@/lib/google-news";

describe("localeForTicker", () => {
  it("maps European exchange suffixes to local locales", () => {
    expect(localeForTicker("GALP.LS")).toMatchObject({ hl: "pt-PT", gl: "PT", lang: "pt" });
    expect(localeForTicker("MC.PA")).toMatchObject({ gl: "FR" });
    expect(localeForTicker("SAP.DE")).toMatchObject({ gl: "DE" });
    expect(localeForTicker("ITX.MC")).toMatchObject({ gl: "ES" });
    expect(localeForTicker("ENEL.MI")).toMatchObject({ gl: "IT" });
    expect(localeForTicker("ASML.AS")).toMatchObject({ gl: "NL" });
    expect(localeForTicker("TSCO.L")).toMatchObject({ hl: "en-GB", gl: "GB" });
  });

  it("does not confuse .LS with .L", () => {
    expect(localeForTicker("EDP.LS").gl).toBe("PT");
    expect(localeForTicker("BP.L").gl).toBe("GB");
  });

  it("defaults to US/English for US tickers", () => {
    expect(localeForTicker("AAPL")).toMatchObject({ hl: "en-US", gl: "US" });
  });
});

describe("googleNewsQuery", () => {
  it("searches the formal name OR the parenthetical alias (often the common name)", () => {
    expect(googleNewsQuery("Industria de Diseño Textil (Inditex)")).toBe(
      '"Industria de Diseño Textil" OR "Inditex"'
    );
    expect(googleNewsQuery("Banco Comercial Português (Millennium BCP)")).toBe(
      '"Banco Comercial Português" OR "Millennium BCP"'
    );
  });

  it("quotes a single phrase when there's no alias", () => {
    expect(googleNewsQuery("Galp Energia")).toBe('"Galp Energia"');
  });

  it("replaces em/en dashes but keeps real hyphens", () => {
    expect(googleNewsQuery("EDP — Energias de Portugal")).toBe('"EDP Energias de Portugal"');
    expect(googleNewsQuery("Mota-Engil SGPS")).toBe('"Mota-Engil SGPS"');
  });
});

describe("parseGoogleNewsRss", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Galp lidera perdas na bolsa - Jornal de Negócios</title>
      <link>https://news.google.com/rss/articles/NEW</link>
      <pubDate>Mon, 08 Jun 2026 09:00:00 GMT</pubDate>
      <source url="https://jornaldenegocios.pt">Jornal de Negócios</source>
    </item>
    <item>
      <title>Notícia antiga - ECO</title>
      <link>https://news.google.com/rss/articles/OLD</link>
      <pubDate>Tue, 01 Jan 2019 09:00:00 GMT</pubDate>
      <source url="https://eco.pt">ECO</source>
    </item>
  </channel></rss>`;

  it("keeps only items at or after `since` and strips the trailing publisher", () => {
    const articles = parseGoogleNewsRss(xml, new Date("2026-06-01T00:00:00Z"));
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      title: "Galp lidera perdas na bolsa",
      url: "https://news.google.com/rss/articles/NEW",
      source: "Jornal de Negócios",
    });
  });

  it("returns nothing when all items predate `since`", () => {
    expect(parseGoogleNewsRss(xml, new Date("2030-01-01T00:00:00Z"))).toHaveLength(0);
  });
});
