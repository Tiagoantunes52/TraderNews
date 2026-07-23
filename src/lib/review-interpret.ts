// LLM interpretation of the daily post-close review, delivered to Slack.
//
// Runs inside the review stage (src/lib/pipeline/review.ts), right after the report is
// persisted — so it rides the same reliable pg_cron trigger that produces the report.
// (GitHub Actions is only the review stage's *backup* trigger and is known to drift or
// skip; see review.yml. Triggering the interpretation separately from GH Actions would
// re-inherit that unreliability, so it lives here instead.)
//
// The report's figures are authoritative; the model only prioritizes and explains, it
// never recomputes. Best-effort: any failure is returned to the caller but must never
// fail the stage. A deterministic fallback posts the raw findings if the LLM is down,
// so Slack still gets the facts.
//
// Config (the whole step is gated on SLACK_WEBHOOK_URL; the LLM env is shared with the
// sentiment stage — see src/lib/llm.ts):
//   SLACK_WEBHOOK_URL  Slack incoming-webhook URL — enables + targets the post
//   VLLM_URL           OpenRouter base (…/api/v1)
//   LLM_API_KEY        OpenRouter key
//   VLLM_MODEL         sentiment model — the default review model when unset
//   REVIEW_LLM_MODEL   (optional) a dedicated, usually stronger, model for the review

import type { DailyReviewReport } from "@/lib/daily-review";

export type ReviewStatusRow = { date: string; status: string; findingCount: number };

const REQUEST_TIMEOUT_MS = 45_000;
const STATUS_EMOJI: Record<string, string> = { OK: "✅", WARN: "⚠️", FAIL: "🚨" };

/** Slack delivery is the gate: no webhook, no interpretation step. */
export function isReviewSlackConfigured(): boolean {
  return !!process.env.SLACK_WEBHOOK_URL;
}

function llmConfig(): { url: string; key: string; model: string } | null {
  const url = process.env.VLLM_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.REVIEW_LLM_MODEL || process.env.VLLM_MODEL;
  if (!url || !key || !model) return null;
  return { url: url.replace(/\/$/, ""), key, model };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT = `You are a trading-systems reliability analyst. You are handed a DETERMINISTIC post-close self-audit of an automated paper-trading system — already computed by the app — and you interpret it for an operator reading Slack.

Rules:
- NEVER recompute, estimate, or invent a number. Every figure in the report is authoritative; you prioritize and explain, you do not recalculate.
- Lead with the overall status. Then, for each FAIL (most important first), give one line: what broke, why it matters, and the single most useful next action. Group repeated codes into one line with the affected count.
- Add at most two lines on WARN-level trends, using the recent status history for context (e.g. "3rd straight day with unprotected positions").
- Be terse — this is an operational alert, not an essay. Target under 1500 characters.
- Output Slack mrkdwn ONLY: *bold*, _italic_, and "• " bullets. No markdown headings (#), no code fences, no preamble such as "Here is".`;

async function callLlm(
  cfg: { url: string; key: string; model: string },
  report: DailyReviewReport,
  history: ReviewStatusRow[]
): Promise<string> {
  const user = `REPORT:\n${JSON.stringify(report)}\n\nRECENT STATUS HISTORY (newest first):\n${JSON.stringify(history)}`;
  const res = await fetchWithTimeout(`${cfg.url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") throw new Error("LLM returned empty content");
  return content.trim();
}

/**
 * Deterministic fallback so Slack still gets the facts if the LLM is unreachable — the
 * same philosophy as the app: the facts survive whether or not interpretation does.
 * Exported for unit testing.
 */
export function buildFallbackMessage(report: DailyReviewReport): string {
  const fails = report.findings.filter((f) => f.severity === "fail");
  const warns = report.findings.filter((f) => f.severity === "warn");
  const head = fails.length ? "*Failures:*" : "No failures.";
  const lines = fails.map((f) => `• *${f.title}* — ${f.detail}`);
  const warnLine = warns.length ? `\n_${warns.length} warning(s) — see the dashboard._` : "";
  return `_(interpreter LLM unavailable — raw findings)_\n${head}\n${lines.join("\n")}${warnLine}`.trim();
}

function buildHeader(report: DailyReviewReport): string {
  const emoji = STATUS_EMOJI[report.status] ?? "❔";
  return (
    `${emoji} *Daily Post-Close Review — ${report.date}* (${report.status})\n` +
    `_${report.summary.fails} fail · ${report.summary.warns} warn · ${report.summary.openPositions} open positions_`
  );
}

async function postSlack(webhook: string, text: string): Promise<void> {
  const res = await fetchWithTimeout(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Slack post failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}

/**
 * Interpret the report with the LLM (one retry, then deterministic fallback) and post
 * it to Slack. Never throws — returns a status the caller records as a non-fatal note.
 */
export async function interpretAndPostReview(
  report: DailyReviewReport,
  history: ReviewStatusRow[]
): Promise<{ ok: boolean; usedFallback: boolean; error?: string }> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return { ok: false, usedFallback: false, error: "SLACK_WEBHOOK_URL not set" };

  let body: string;
  let usedFallback = false;
  const cfg = llmConfig();
  if (!cfg) {
    usedFallback = true;
    body = buildFallbackMessage(report);
  } else {
    try {
      body = await callLlm(cfg, report, history);
    } catch {
      try {
        body = await callLlm(cfg, report, history);
      } catch {
        usedFallback = true;
        body = buildFallbackMessage(report);
      }
    }
  }

  try {
    await postSlack(webhook, `${buildHeader(report)}\n\n${body}`);
    return { ok: true, usedFallback };
  } catch (e) {
    return { ok: false, usedFallback, error: e instanceof Error ? e.message : String(e) };
  }
}
