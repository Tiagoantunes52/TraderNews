import { describe, it, expect, afterEach, vi } from "vitest";
import { buildAlertEmail, buildReviewEmail, isEmailConfigured, sendEmail } from "@/lib/email";

describe("buildAlertEmail", () => {
  it("uses the single-alert subject for one alert", () => {
    const { subject, html, text } = buildAlertEmail([
      { title: "AAPL upgraded to Buy", message: "signal moved up" },
    ]);
    expect(subject).toBe("TraderNews alert: AAPL upgraded to Buy");
    expect(html).toContain("AAPL upgraded to Buy");
    expect(text).toContain("AAPL upgraded to Buy");
  });

  it("uses a count subject for multiple alerts", () => {
    const { subject, html } = buildAlertEmail([
      { title: "A", message: "m1" },
      { title: "B", message: "m2" },
    ]);
    expect(subject).toBe("TraderNews: 2 new alerts");
    expect(html).toContain("A");
    expect(html).toContain("B");
  });

  it("escapes HTML in alert content", () => {
    const { html } = buildAlertEmail([
      { title: "<script>x</script>", message: "a & b > c" },
    ]);
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b &gt; c");
  });
});

describe("isEmailConfigured / sendEmail", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
    vi.restoreAllMocks();
  });

  it("is not configured when keys are missing", () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_FROM_EMAIL;
    expect(isEmailConfigured()).toBe(false);
  });

  it("is configured when both keys are present", () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.ALERT_FROM_EMAIL = "alerts@example.com";
    expect(isEmailConfigured()).toBe(true);
  });

  it("returns an error result instead of calling fetch when unconfigured", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.ALERT_FROM_EMAIL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await sendEmail({ to: "x@y.com", subject: "s", html: "<p>h</p>" });
    expect(res.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to Resend with auth + from when configured", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.ALERT_FROM_EMAIL = "alerts@example.com";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "1" }), { status: 200 }));

    const res = await sendEmail({ to: "x@y.com", subject: "s", html: "<p>h</p>", text: "h" });
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.from).toBe("alerts@example.com");
    expect(body.to).toBe("x@y.com");
  });

  it("surfaces a non-ok Resend response as an error", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.ALERT_FROM_EMAIL = "alerts@example.com";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad request", { status: 422 })
    );
    const res = await sendEmail({ to: "x@y.com", subject: "s", html: "<p>h</p>" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("422");
  });
});

describe("buildReviewEmail", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    date: "2026-07-21",
    status: "OK",
    summary: {
      findings: 0,
      fails: 0,
      warns: 0,
      openPositions: 4,
      openedToday: 1,
      closedToday: 2,
      realizedToday: 123.45,
    },
    findings: [] as { severity: string; code: string; title: string; detail: string }[],
    notes: [] as string[],
    ...over,
  });

  it("leads with the all-clear when nothing was found", () => {
    const { subject, html, text } = buildReviewEmail(report());
    expect(subject).toBe("TraderNews review 2026-07-21: all clear");
    expect(html).toContain("Nothing needs attention today.");
    expect(text).toContain("[OK]");
  });

  it("counts failures in the subject ahead of warnings", () => {
    const { subject } = buildReviewEmail(
      report({
        status: "FAIL",
        summary: { ...report().summary, findings: 3, fails: 2, warns: 1 },
      })
    );
    expect(subject).toBe("TraderNews review 2026-07-21: 2 failures");
  });

  it("falls back to the warning count when there are no failures", () => {
    const { subject } = buildReviewEmail(
      report({ status: "WARN", summary: { ...report().summary, findings: 1, fails: 0, warns: 1 } })
    );
    expect(subject).toBe("TraderNews review 2026-07-21: 1 warning");
  });

  it("shows the day's trading activity", () => {
    const { text } = buildReviewEmail(report());
    expect(text).toContain("1 opened");
    expect(text).toContain("2 closed");
    expect(text).toContain("$123.45 realized");
    expect(text).toContain("4 open");
  });

  it("keeps tuning noise out of the body but says how much was withheld", () => {
    const { html, text } = buildReviewEmail(
      report({
        findings: [
          { severity: "fail", code: "MISSED_EXIT", title: "AAPL still open", detail: "meets the STOP exit" },
          { severity: "info", code: "TUNE_TIME_STOP", title: "tune me", detail: "d1" },
          { severity: "info", code: "TUNE_STOP_DISTANCE", title: "tune me too", detail: "d2" },
        ],
      })
    );
    expect(html).toContain("AAPL still open");
    expect(html).not.toContain("tune me");
    expect(html).toContain("2 informational findings");
    expect(text).toContain("[FAIL] AAPL still open");
  });

  it("escapes HTML in finding content", () => {
    const { html } = buildReviewEmail(
      report({
        findings: [{ severity: "warn", code: "X", title: "<script>x</script>", detail: "a & b" }],
      })
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b");
  });

  it("carries the notes that explain what could not be checked", () => {
    const { html, text } = buildReviewEmail(report({ notes: ["Alpaca is not configured"] }));
    expect(html).toContain("Alpaca is not configured");
    expect(text).toContain("Alpaca is not configured");
  });
});
