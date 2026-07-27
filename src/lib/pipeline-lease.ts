// Mutual exclusion for a pipeline stage (issue: the paper stage could run twice).
//
// The old guard was read-then-act: read today's SIM_COMBINED snapshot, and if absent,
// do the whole run. Two invocations could both read "absent", both open positions, and
// both submit broker orders. That is not hypothetical here — the two schedulers are
// deliberately aligned on the same minute: GH Actions fires `30 19` and `30 20` on
// weekdays, and the Supabase pg_cron tick runs `*/5 16-21` on weekdays, so they collide
// at 19:30 and 20:30 every weekday.
//
// WHY A LEASE ROW AND NOT AN ADVISORY LOCK
// `pg_try_advisory_lock` is session-scoped, and through a connection pooler you do not
// own a session across statements — the lock can be taken on one pooled connection and
// the next query runs on another. `pg_try_advisory_xact_lock` is reliable but only
// lasts the transaction, and this stage runs to a 300s budget across dozens of awaits
// and external HTTP calls; holding a transaction open across all of that is worse than
// the problem. A row with an expiry survives both pooling and process death.
//
// WHY THIS IS NOT THE IDEMPOTENCY MARKER
// The per-day marker (the SIM_COMBINED snapshot) is written LAST, on purpose, so a run
// that dies half-way is retried rather than skipped. A lease must be taken FIRST or it
// excludes nothing. They are different objects with opposite lifecycles; merging them
// would fix the race and break crash-retry. Both are kept.

import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

/** Stages that take a lease. One row per stage (the table's primary key). */
export type LeaseStage = "paper";

/**
 * How long a lease stays valid. Must exceed the longest plausible run — a lease that
 * expires mid-run lets a second invocation in, which is the exact thing being
 * prevented — while staying short enough that a crashed run doesn't block the stage
 * for the rest of the day. The stage budget is 300s; 15 minutes leaves ample headroom.
 */
export const LEASE_TTL_SECONDS = Number(process.env.PIPELINE_LEASE_TTL_SECONDS) || 900;

export type LeaseHandle = { stage: LeaseStage; holder: string };

/**
 * Try to take the stage's lease. Returns a handle on success, `null` when another run
 * holds it — the caller should then no-op, exactly as it would for the per-day marker.
 *
 * The acquire is a single statement so it is atomic under concurrency: the upsert only
 * overwrites a row whose lease has EXPIRED, so two racing runs cannot both match. The
 * `RETURNING` row is the proof — no row means somebody else holds a live lease.
 *
 * Fails OPEN (returns a handle) if the lease table can't be reached. A stage that
 * refuses to run because its lock is unavailable trades a rare double-run for a
 * guaranteed no-run, and the per-day marker still bounds the damage.
 */
export async function acquireLease(
  stage: LeaseStage,
  ttlSeconds = LEASE_TTL_SECONDS
): Promise<LeaseHandle | null> {
  const holder = randomUUID();
  try {
    const rows = await db.$queryRaw<{ holder: string }[]>`
      INSERT INTO "PipelineLease" ("stage", "holder", "acquiredAt", "expiresAt")
      VALUES (${stage}, ${holder}, now(), now() + make_interval(secs => ${ttlSeconds}))
      ON CONFLICT ("stage") DO UPDATE
        SET "holder" = EXCLUDED."holder",
            "acquiredAt" = now(),
            "expiresAt" = EXCLUDED."expiresAt"
        WHERE "PipelineLease"."expiresAt" < now()
      RETURNING "holder"
    `;
    return rows.length > 0 ? { stage, holder } : null;
  } catch {
    return { stage, holder };
  }
}

/**
 * Release the lease, but only if we still hold it. The holder check matters: a run
 * that overran its TTL and had the lease stolen must not delete the new holder's
 * lease on its way out. Never throws — a failed release just leaves the lease to
 * expire, which is the same outcome as a crash.
 */
export async function releaseLease(handle: LeaseHandle): Promise<void> {
  try {
    await db.$executeRaw`
      DELETE FROM "PipelineLease"
       WHERE "stage" = ${handle.stage} AND "holder" = ${handle.holder}
    `;
  } catch {
    // fall through — expiry is the backstop
  }
}
