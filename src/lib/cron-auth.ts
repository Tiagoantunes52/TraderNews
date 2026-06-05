// Shared authorization for the pipeline cron endpoints.
//
// Accepts either the Vercel-style cron bearer token (CRON_SECRET) or the custom
// header used by the GitHub Actions workflow (x-pipeline-secret / PIPELINE_SECRET).
export function isPipelineAuthorized(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`) return true;

  const secret = req.headers.get("x-pipeline-secret");
  if (process.env.PIPELINE_SECRET && secret === process.env.PIPELINE_SECRET) return true;

  return false;
}
