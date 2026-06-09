/**
 * Structured logger for TraderNews.
 *
 * Why a small custom logger (and not pino)?
 * - On Vercel Hobby we can't use Log Drains (Pro-only), so the app has to ship
 *   its own logs. This logger writes structured JSON to stdout/stderr — which
 *   Vercel runtime logs and GitHub Actions output still capture — AND best-effort
 *   ships the same records to Axiom for 30-day, queryable retention.
 * - It runs in the Node *and* Edge runtimes with zero native deps. pino relies on
 *   Node worker-thread transports that don't run on Edge (`src/proxy.ts`); a plain
 *   `fetch` transport runs everywhere.
 *
 * Contract:
 * - Logging is best-effort: it MUST NEVER throw, and the Axiom POST never blocks
 *   the caller beyond an explicit `flush()`.
 * - Axiom shipping disables itself when AXIOM_TOKEN/AXIOM_DATASET are absent
 *   (local dev, CI) and the whole logger goes silent under NODE_ENV=test.
 * - Serverless instances can freeze right after the response is sent, so anything
 *   on a request path should `await log.flush()` before returning. `withRoute`
 *   (see observability.ts) does this for you.
 *
 * The public surface is intentionally tiny (info/warn/error/debug/child/flush) so
 * the implementation underneath can be swapped (e.g. for pino) without touching
 * call sites.
 */

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET;
const AXIOM_URL = process.env.AXIOM_URL ?? "https://api.axiom.co";
const AXIOM_ENABLED = Boolean(AXIOM_TOKEN && AXIOM_DATASET);

// Axiom's regional edge domains (e.g. eu-central-1.aws.edge.axiom.co) use a
// different ingest path (`/v1/ingest/{dataset}`) than the standard API
// (`/v1/datasets/{dataset}/ingest`). Pick the right one from the host.
const AXIOM_INGEST_URL = AXIOM_URL.includes(".edge.axiom.co")
  ? `${AXIOM_URL}/v1/ingest/${encodeURIComponent(AXIOM_DATASET ?? "")}`
  : `${AXIOM_URL}/v1/datasets/${encodeURIComponent(AXIOM_DATASET ?? "")}/ingest`;

const SERVICE = "tradernews";
// VERCEL_ENV is "production" | "preview" | "development" on Vercel.
const ENV = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
const RELEASE = process.env.VERCEL_GIT_COMMIT_SHA;

// Tests stay silent unless LOG_LEVEL is set explicitly, so unit runs don't spam
// stdout or attempt network I/O.
const MIN_LEVEL: number = (() => {
  const explicit = process.env.LOG_LEVEL as Level | undefined;
  if (explicit && explicit in LEVEL_ORDER) return LEVEL_ORDER[explicit];
  if (process.env.NODE_ENV === "test") return Number.POSITIVE_INFINITY; // silent
  return LEVEL_ORDER.info;
})();

type LogRecord = {
  _time: string; // Axiom uses this as the event timestamp
  level: Level;
  msg: string;
  service: string;
  env: string;
  release?: string;
} & Fields;

// Per-instance buffer. Fluid Compute reuses an instance across concurrent
// requests; that's fine — flush ships whatever is buffered and every record
// still reaches Axiom. A hard cap guards memory if a flush never happens.
const MAX_BUFFER = 100;
let buffer: LogRecord[] = [];
let inFlight: Promise<void> | null = null;
// Surface an Axiom delivery failure to stderr exactly once per instance, so a
// misconfig (wrong region/dataset/token) is visible in Vercel logs instead of
// being silently swallowed. Never sent back to Axiom (would loop).
let axiomWarned = false;

function ship(): Promise<void> {
  if (!AXIOM_ENABLED || buffer.length === 0) return inFlight ?? Promise.resolve();
  const batch = buffer;
  buffer = [];
  inFlight = fetch(AXIOM_INGEST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AXIOM_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(5_000),
    keepalive: true, // let the POST finish even as the function winds down
  })
    .then(async (res) => {
      if (!res.ok && !axiomWarned) {
        axiomWarned = true;
        const detail = await res.text().catch(() => "");
        console.warn(`[logger] Axiom ingest failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
      }
    })
    .catch((e) => {
      // best-effort: a logging failure must never surface to the caller
      if (!axiomWarned) {
        axiomWarned = true;
        console.warn(`[logger] Axiom ingest error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  return inFlight;
}

function emit(level: Level, msg: string, base: Fields, fields?: Fields): void {
  if (LEVEL_ORDER[level] < MIN_LEVEL) return;
  const record: LogRecord = {
    _time: new Date().toISOString(),
    level,
    msg,
    service: SERVICE,
    env: ENV,
    ...(RELEASE ? { release: RELEASE } : {}),
    ...base,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  if (AXIOM_ENABLED) {
    buffer.push(record);
    if (buffer.length >= MAX_BUFFER) void ship();
  }
}

export type Logger = {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** Returns a logger that merges `fields` into every record (e.g. requestId). */
  child(fields: Fields): Logger;
  /** Awaits delivery of buffered records to Axiom. Call before a serverless return. */
  flush(): Promise<void>;
};

function make(base: Fields): Logger {
  return {
    debug: (m, f) => emit("debug", m, base, f),
    info: (m, f) => emit("info", m, base, f),
    warn: (m, f) => emit("warn", m, base, f),
    error: (m, f) => emit("error", m, base, f),
    child: (f) => make({ ...base, ...f }),
    flush: async () => {
      await ship();
      if (inFlight) await inFlight;
    },
  };
}

export const logger: Logger = make({});
