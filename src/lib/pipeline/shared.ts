import { db } from "@/lib/db";
import { EMAIL_ALLOWED_ALERT_TYPES, type AlertDraft } from "@/lib/alerts";
import { isEmailConfigured, sendEmail, buildAlertEmail } from "@/lib/email";

// Per-invocation work budget. Stages stop scheduling new stocks once the budget
// elapses and report what's left so a follow-up invocation resumes — keeping any
// single serverless call well under its limit. Tunable via env without a redeploy
// (per-stage concurrency knobs live in each stage's module).
export const STAGE_BUDGET_MS = Number(process.env.PIPELINE_STAGE_BUDGET_MS) || 240_000;

export type StageOptions = { budgetMs?: number; concurrency?: number };

/**
 * Outcome of a per-stock stage invocation.
 * `done` means the whole worklist was *attempted* this invocation (the GH Actions
 * orchestrator loops until it sees `done: true`). A stock can be attempted without
 * producing a row — e.g. it has no linked articles, or its fetch failed — in which
 * case it stays in the next worklist and is retried, but it never blocks `done`.
 */
export type BatchStageResult = {
  stage: "sentiment" | "quant" | "estimate" | "insider";
  attempted: number; // worklist items handled this invocation (incl. skips/failures)
  created: number; // DB rows actually written
  remaining: number; // worklist items deferred to a later invocation (budget hit)
  done: boolean;
  alerts: number; // alerts persisted (estimate stage only)
  errors: string[];
};

export type PendingAlert = { stockId: string; ticker: string; draft: AlertDraft };

/**
 * Persist new alert events and email watchers (one digest per recipient).
 * Only users with alertEmails enabled and an email on file are notified.
 */
export async function processAlerts(pending: PendingAlert[]): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = [];
  if (pending.length === 0) return { count: 0, errors };

  await db.alert.createMany({
    data: pending.map((p) => ({
      stockId: p.stockId,
      type: p.draft.type,
      title: p.draft.title,
      message: p.draft.message,
      value: p.draft.value,
    })),
  });

  if (!isEmailConfigured()) return { count: pending.length, errors };

  const stockIds = [...new Set(pending.map((p) => p.stockId))];
  const watchers = await db.userStock.findMany({
    where: { stockId: { in: stockIds }, user: { alertEmails: true, email: { not: null } } },
    select: { stockId: true, user: { select: { id: true, email: true } } },
  });

  // Group alerts per recipient so each user gets a single digest. Only the emailable
  // types (open-market insider buys) go in — every other per-stock alert is persisted
  // above and surfaces in the dashboard feed, but is kept out of inboxes.
  const byUser = new Map<string, { email: string; drafts: AlertDraft[] }>();
  for (const w of watchers) {
    if (!w.user.email) continue;
    const entry = byUser.get(w.user.id) ?? { email: w.user.email, drafts: [] };
    for (const p of pending) {
      if (p.stockId === w.stockId && EMAIL_ALLOWED_ALERT_TYPES.has(p.draft.type)) entry.drafts.push(p.draft);
    }
    byUser.set(w.user.id, entry);
  }

  for (const { email, drafts } of byUser.values()) {
    if (drafts.length === 0) continue;
    const { subject, html, text } = buildAlertEmail(drafts);
    const res = await sendEmail({ to: email, subject, html, text });
    if (!res.ok) errors.push(`Alert email to ${email} failed: ${res.error}`);
  }

  return { count: pending.length, errors };
}

/**
 * Persist account / trading-health alerts (issue #56) and notify admins. These
 * carry no ticker (stockId null) and aren't tied to any user's watchlist, so they
 * go to admins with alert emails on — operators, not per-stock watchers.
 */
export async function processAccountAlerts(drafts: AlertDraft[]): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = [];
  if (drafts.length === 0) return { count: 0, errors };

  await db.alert.createMany({
    data: drafts.map((d) => ({ stockId: null, type: d.type, title: d.title, message: d.message, value: d.value })),
  });

  if (!isEmailConfigured()) return { count: drafts.length, errors };

  const admins = await db.user.findMany({
    where: { role: "ADMIN", alertEmails: true, email: { not: null } },
    select: { email: true },
  });
  const { subject, html, text } = buildAlertEmail(drafts);
  for (const a of admins) {
    if (!a.email) continue;
    const res = await sendEmail({ to: a.email, subject, html, text });
    if (!res.ok) errors.push(`Account alert email to ${a.email} failed: ${res.error}`);
  }
  return { count: drafts.length, errors };
}

export function dateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

/** UTC midnight of the given date — the boundary for "already done today" guards. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Watched stocks (those at least one user holds). */
export function watchedStocksWhere() {
  return { userStocks: { some: {} } } as const;
}

/**
 * The data-coverage universe for the core signal stages (news → sentiment → quant →
 * estimate → paper). The automated trader is **US-equity only**, so coverage is
 * tiered for efficiency:
 *   • US equities (no exchange suffix, not crypto) are analysed in full — watched or
 *     not — because they're what we trade and want the most history on;
 *   • everything else (European listings, crypto) is analysed only when a user
 *     watches it — no point spending pipeline budget on non-tradable names nobody
 *     follows.
 * Insider & Congress stay fully watchlist-scoped (`watchedStocksWhere`) to respect
 * the Finnhub (60/min) and AInvest (hard-throttle) free-tier limits.
 */
export function universeWhere() {
  return {
    OR: [
      // US equities: no dot (excludes European .XX listings) and not crypto (-USD).
      { AND: [{ NOT: { ticker: { contains: "." } } }, { NOT: { ticker: { endsWith: "-USD" } } }] },
      // Non-US (European listings, crypto): only when at least one user watches it.
      { userStocks: { some: {} } },
    ],
  };
}
