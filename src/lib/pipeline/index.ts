// The data pipeline, one module per stage (news → sentiment → quant → estimate →
// paper, plus insider + congress on their own workflow). Cross-stage plumbing
// (budgets, worklist scopes, alert fan-out) lives in ./shared. This barrel is the
// public surface: existing imports from "@/lib/pipeline" resolve here unchanged.
import { runNewsStage } from "./news";
import { runSentimentStage } from "./sentiment";
import { runQuantStage } from "./quant";
import { runEstimateStage } from "./estimate";
import { runInsiderStage } from "./insider";
import type { BatchStageResult, StageOptions } from "./shared";

export { runNewsStage, type NewsStageResult } from "./news";
export { runSentimentStage } from "./sentiment";
export { runQuantStage } from "./quant";
export { runEstimateStage } from "./estimate";
export { runInsiderStage } from "./insider";
export { runCongressStage, type CongressStageResult } from "./congress";
export { runPaperStage, type PaperStageResult } from "./paper";
export { runReviewStage, type ReviewStageResult } from "./review";
export { type BatchStageResult, type StageOptions } from "./shared";

// Re-exported so existing imports from "@/lib/pipeline" keep working.
export { normalizeUrl, normalizeHeadline } from "@/lib/normalize";

export type PipelineResult = {
  articles: { fetched: number; saved: number };
  tags: number;
  sentiments: number;
  quants: number;
  estimates: number;
  insider: number;
  alerts: number;
  errors: string[];
};

/**
 * Run a batched stage repeatedly until it reports `done`, accumulating results.
 * Used by the all-in-one orchestrator (admin "run now" + local debug); the GH
 * Actions cron instead loops each stage's HTTP endpoint, so no single serverless
 * invocation runs longer than one budget window.
 */
async function runStageToCompletion(
  stage: (opts?: StageOptions) => Promise<BatchStageResult>,
  maxIterations = 50
): Promise<{ created: number; alerts: number; errors: string[] }> {
  let created = 0;
  let alerts = 0;
  const errors: string[] = [];
  for (let i = 0; i < maxIterations; i++) {
    const r = await stage();
    created += r.created;
    alerts += r.alerts;
    errors.push(...r.errors);
    if (r.done) break;
  }
  return { created, alerts, errors };
}

/**
 * All-in-one run: every stage to completion, in dependency order. Kept for the
 * admin trigger and the local debug script; the scheduled cron uses the per-stage
 * endpoints instead so each invocation stays within its time limit.
 */
export async function runPipeline(): Promise<PipelineResult> {
  const result: PipelineResult = { articles: { fetched: 0, saved: 0 }, tags: 0, sentiments: 0, quants: 0, estimates: 0, insider: 0, alerts: 0, errors: [] };

  // News now walks the universe in budget-bounded chunks, so loop it to completion
  // (like the per-stock stages) instead of a single pass.
  for (let i = 0; i < 50; i++) {
    const news = await runNewsStage();
    result.articles.fetched += news.articles.fetched;
    result.articles.saved += news.articles.saved;
    result.tags += news.tags;
    result.errors.push(...news.errors);
    if (news.done) break;
  }

  const sentiment = await runStageToCompletion(runSentimentStage);
  result.sentiments = sentiment.created;
  result.errors.push(...sentiment.errors);

  const quant = await runStageToCompletion(runQuantStage);
  result.quants = quant.created;
  result.errors.push(...quant.errors);

  const estimate = await runStageToCompletion(runEstimateStage);
  result.estimates = estimate.created;
  result.alerts += estimate.alerts;
  result.errors.push(...estimate.errors);

  const insider = await runStageToCompletion(runInsiderStage);
  result.insider = insider.created;
  result.alerts += insider.alerts;
  result.errors.push(...insider.errors);

  return result;
}
