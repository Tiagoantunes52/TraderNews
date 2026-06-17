import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPipelineAuthorized } from "@/lib/cron-auth";

// Minimal Request stub — isPipelineAuthorized only reads req.headers.get(name).
function reqWith(headers: Record<string, string>): Request {
  return { headers: { get: (k: string) => headers[k] ?? null } } as unknown as Request;
}

describe("isPipelineAuthorized()", () => {
  const prevCron = process.env.CRON_SECRET;
  const prevPipe = process.env.PIPELINE_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = "cron-xyz";
    process.env.PIPELINE_SECRET = "pipe-abc";
  });
  afterEach(() => {
    if (prevCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevCron;
    if (prevPipe === undefined) delete process.env.PIPELINE_SECRET;
    else process.env.PIPELINE_SECRET = prevPipe;
  });

  it("accepts the correct Vercel cron bearer token", () => {
    expect(isPipelineAuthorized(reqWith({ authorization: "Bearer cron-xyz" }))).toBe(true);
  });

  it("accepts the correct GitHub Actions pipeline secret header", () => {
    expect(isPipelineAuthorized(reqWith({ "x-pipeline-secret": "pipe-abc" }))).toBe(true);
  });

  it("rejects a wrong bearer token or wrong pipeline secret", () => {
    expect(isPipelineAuthorized(reqWith({ authorization: "Bearer nope" }))).toBe(false);
    expect(isPipelineAuthorized(reqWith({ "x-pipeline-secret": "nope" }))).toBe(false);
  });

  it("rejects when no auth headers are present", () => {
    expect(isPipelineAuthorized(reqWith({}))).toBe(false);
  });

  it("does not throw on length-mismatched candidates (digests are fixed-length)", () => {
    expect(isPipelineAuthorized(reqWith({ authorization: "Bearer x", "x-pipeline-secret": "y" }))).toBe(false);
    expect(() => isPipelineAuthorized(reqWith({ authorization: `Bearer ${"a".repeat(500)}` }))).not.toThrow();
  });

  it("rejects when the env secret is unset even if a matching header is sent", () => {
    delete process.env.CRON_SECRET;
    delete process.env.PIPELINE_SECRET;
    expect(isPipelineAuthorized(reqWith({ authorization: "Bearer cron-xyz", "x-pipeline-secret": "pipe-abc" }))).toBe(false);
  });
});
