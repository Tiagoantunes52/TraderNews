/** Canonical URL form: drop query params, fragments, and trailing slashes. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

/** Canonical headline form for cross-source syndication matching. */
export function normalizeHeadline(headline: string): string {
  return headline.toLowerCase().replace(/\s+/g, " ").trim();
}
