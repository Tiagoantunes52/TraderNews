import { describe, it, expect } from "vitest";
import {
  PRIVATE_COMPANY_SEED,
  privateCompanySlug,
  privateCompanyQuery,
  dedupeArticles,
} from "@/lib/private-companies";
import type { GoogleNewsArticle } from "@/lib/google-news";

describe("PRIVATE_COMPANY_SEED", () => {
  it("contains the canonical issue #63 companies", () => {
    const names = PRIVATE_COMPANY_SEED.map((s) => s.name);
    for (const expected of [
      "OpenAI",
      "Anthropic",
      "xAI",
      "Databricks",
      "Stripe",
      "Scale AI",
      "Anduril",
      "Perplexity",
      "Cognition",
      "Mistral",
      "Canva",
      "ByteDance",
      "Figure AI",
      "Rippling",
      "Ramp",
      "Epic Games",
      "Commonwealth Fusion Systems",
      "Helion Energy",
      "Shield AI",
    ]) {
      expect(names).toContain(expected);
    }
    expect(names).toHaveLength(19);
  });

  it("does not seed Chime (went public as CHYM on 2025-06-12)", () => {
    expect(PRIVATE_COMPANY_SEED.some((s) => /chime/i.test(s.name))).toBe(false);
  });

  it("produces unique slugs (slug is the sync upsert key)", () => {
    const slugs = PRIVATE_COMPANY_SEED.map((s) => privateCompanySlug(s.name));
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("privateCompanySlug()", () => {
  it("lowercases and dashes multi-word names", () => {
    expect(privateCompanySlug("Commonwealth Fusion Systems")).toBe("commonwealth-fusion-systems");
    expect(privateCompanySlug("Scale AI")).toBe("scale-ai");
    expect(privateCompanySlug("xAI")).toBe("xai");
  });

  it("strips punctuation and collapses separators", () => {
    expect(privateCompanySlug("Epic  Games, Inc.")).toBe("epic-games-inc");
    expect(privateCompanySlug("--OpenAI--")).toBe("openai");
  });

  it("strips diacritics", () => {
    expect(privateCompanySlug("Café Müller")).toBe("cafe-muller");
  });
});

describe("privateCompanyQuery()", () => {
  it("quotes the name by default", () => {
    expect(privateCompanyQuery({ name: "OpenAI" })).toBe('"OpenAI"');
    expect(privateCompanyQuery({ name: "Commonwealth Fusion Systems" })).toBe(
      '"Commonwealth Fusion Systems"'
    );
  });

  it("normalizes internal whitespace in the default query", () => {
    expect(privateCompanyQuery({ name: "  Scale   AI " })).toBe('"Scale AI"');
  });

  it("prefers the explicit override for ambiguous names", () => {
    expect(privateCompanyQuery({ name: "Mistral", query: '"Mistral AI"' })).toBe('"Mistral AI"');
  });

  it("every ambiguity-prone seed entry carries an override", () => {
    for (const name of ["Mistral", "Cognition", "Ramp", "xAI"]) {
      const seed = PRIVATE_COMPANY_SEED.find((s) => s.name === name)!;
      expect(seed.query, `${name} needs a query override`).toBeTruthy();
    }
  });
});

describe("dedupeArticles()", () => {
  const art = (url: string, title = "t"): GoogleNewsArticle => ({
    title,
    url,
    publishedAt: new Date("2026-07-01T00:00:00Z"),
    source: "Src",
  });

  it("drops batch-internal URL duplicates, keeping the first", () => {
    const out = dedupeArticles([art("https://a", "first"), art("https://b"), art("https://a", "second")]);
    expect(out.map((a) => a.url)).toEqual(["https://a", "https://b"]);
    expect(out[0].title).toBe("first");
  });

  it("passes distinct URLs through unchanged", () => {
    const input = [art("https://a"), art("https://b"), art("https://c")];
    expect(dedupeArticles(input)).toEqual(input);
  });

  it("handles the empty batch", () => {
    expect(dedupeArticles([])).toEqual([]);
  });
});
