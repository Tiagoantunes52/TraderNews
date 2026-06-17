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

/**
 * True only for absolute http(s) URLs. External news feeds are untrusted, so a
 * spoofed entry could carry a `javascript:`/`data:` URL that we'd otherwise render
 * as an `<a href>` (#18). The URL constructor normalizes scheme case and strips
 * leading control/space chars, so obfuscated schemes ("\tJavaScript:…") are caught.
 */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** A render-safe href for external links: the URL if it's http(s), else "#". */
export function safeExternalHref(url: string): string {
  return isHttpUrl(url) ? url : "#";
}
