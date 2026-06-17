// Shared authorization for the pipeline cron endpoints.
//
// Accepts either the Vercel-style cron bearer token (CRON_SECRET) or the custom
// header used by the GitHub Actions workflow (x-pipeline-secret / PIPELINE_SECRET).
import { timingSafeEqual, createHash } from "node:crypto";

// Constant-time secret compare (#20). Hash both sides to fixed-length SHA-256
// digests first, so a length difference neither leaks via timing nor makes
// timingSafeEqual throw on mismatched buffer lengths.
function secretsMatch(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function isPipelineAuthorized(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader && secretsMatch(authHeader, `Bearer ${process.env.CRON_SECRET}`)) {
    return true;
  }

  const secret = req.headers.get("x-pipeline-secret");
  if (process.env.PIPELINE_SECRET && secret && secretsMatch(secret, process.env.PIPELINE_SECRET)) {
    return true;
  }

  return false;
}
