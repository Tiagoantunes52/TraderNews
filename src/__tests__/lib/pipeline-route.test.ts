// @vitest-environment node
//
// Node environment, not the jsdom default: this suite pulls in `lib/pipeline` →
// `lib/observability` → `@sentry/nextjs`, whose vendored orchestrion webpack shim
// branches on `typeof document`. Under jsdom it takes the BROWSER branch, resolves
// its loader path against `document.baseURI` (an http: URL) and dies in
// `fileURLToPath` with "The URL must be of scheme file" before a single test runs.
// Nothing here touches the DOM, and the real server runtime has no `document` either,
// so `node` is both the fix and the honest environment for this file.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stageRoute } from "@/lib/pipeline-route";

// Protected-route coverage (issue #63): every pipeline endpoint — including the
// new /api/pipeline/private-companies — is built on stageRoute, so exercising
// the wrapper with a stub stage proves unauthenticated requests are rejected
// before the stage runs.
describe("stageRoute() authorization", () => {
  const prevPipe = process.env.PIPELINE_SECRET;
  const prevCron = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.PIPELINE_SECRET = "pipe-abc";
    process.env.CRON_SECRET = "cron-xyz";
  });
  afterEach(() => {
    if (prevPipe === undefined) delete process.env.PIPELINE_SECRET;
    else process.env.PIPELINE_SECRET = prevPipe;
    if (prevCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevCron;
  });

  const url = "http://localhost/api/pipeline/private-companies";

  it("returns 401 and never runs the stage without credentials", async () => {
    const run = vi.fn().mockResolvedValue({ done: true, errors: [] });
    const handle = stageRoute("private-companies", run);

    const res = await handle(new Request(url, { method: "POST" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong secret", async () => {
    const run = vi.fn().mockResolvedValue({ done: true, errors: [] });
    const handle = stageRoute("private-companies", run);

    const res = await handle(
      new Request(url, { method: "POST", headers: { "x-pipeline-secret": "wrong" } })
    );

    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the stage and returns its result with the pipeline secret", async () => {
    const run = vi.fn().mockResolvedValue({ stage: "private-companies", done: true, errors: [] });
    const handle = stageRoute("private-companies", run);

    const res = await handle(
      new Request(url, { method: "POST", headers: { "x-pipeline-secret": "pipe-abc" } })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stage: "private-companies", done: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
