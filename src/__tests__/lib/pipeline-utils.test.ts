import { describe, it, expect } from "vitest";
import { normalizeUrl, normalizeHeadline } from "@/lib/pipeline";

describe("normalizeUrl()", () => {
  it("strips query parameters", () => {
    expect(normalizeUrl("https://example.com/article?utm_source=tiingo&utm_medium=api"))
      .toBe("https://example.com/article");
  });

  it("strips URL fragment", () => {
    expect(normalizeUrl("https://example.com/article#section")).toBe("https://example.com/article");
  });

  it("strips trailing slash", () => {
    expect(normalizeUrl("https://example.com/article/")).toBe("https://example.com/article");
  });

  it("strips both query params and fragment", () => {
    expect(normalizeUrl("https://example.com/article?ref=rss#top")).toBe("https://example.com/article");
  });

  it("preserves path segments", () => {
    expect(normalizeUrl("https://reuters.com/technology/apple-earnings-2024")).toBe(
      "https://reuters.com/technology/apple-earnings-2024"
    );
  });

  it("returns the input unchanged when URL is invalid", () => {
    expect(normalizeUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("normalizeHeadline()", () => {
  it("lowercases the headline", () => {
    expect(normalizeHeadline("Apple Beats Earnings")).toBe("apple beats earnings");
  });

  it("collapses multiple spaces into one", () => {
    expect(normalizeHeadline("Apple  Beats   Earnings")).toBe("apple beats earnings");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeHeadline("  Apple Beats Earnings  ")).toBe("apple beats earnings");
  });

  it("treats headlines that differ only in case/spacing as equal", () => {
    expect(normalizeHeadline("APPLE BEATS EARNINGS")).toBe(
      normalizeHeadline("apple beats earnings")
    );
    expect(normalizeHeadline("Apple  Beats Earnings")).toBe(
      normalizeHeadline("apple beats earnings")
    );
  });
});
