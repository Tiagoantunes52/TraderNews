import { describe, it, expect } from "vitest";
import { isHttpUrl, safeExternalHref } from "@/lib/normalize";

describe("isHttpUrl()", () => {
  it("accepts http and https", () => {
    expect(isHttpUrl("https://example.com/x")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
  });

  it("rejects dangerous and non-http schemes (incl. case/whitespace obfuscation)", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("JavaScript:alert(1)")).toBe(false);
    expect(isHttpUrl("\tjavascript:alert(1)")).toBe(false); // leading control char stripped by URL()
    expect(isHttpUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
  });

  it("rejects unparseable input", () => {
    expect(isHttpUrl("not-a-url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("safeExternalHref()", () => {
  it("passes through http(s) URLs unchanged", () => {
    expect(safeExternalHref("https://example.com/a")).toBe("https://example.com/a");
  });

  it("neutralizes dangerous/invalid URLs to '#'", () => {
    expect(safeExternalHref("javascript:alert(1)")).toBe("#");
    expect(safeExternalHref("data:text/html,x")).toBe("#");
    expect(safeExternalHref("not-a-url")).toBe("#");
  });
});
