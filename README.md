# TraderNews

TraderNews turns a noisy stream of financial news into an opinion — then measures whether that opinion is any good. For the stocks and crypto you watch it aggregates news, scores each name with **LLM sentiment** and **quantitative technical analysis**, blends them into a single BUY/SELL signal, layers in **insider** and **congressional** trading activity, and runs an autonomous **paper-trading** book that tracks how predictive each signal source actually is.

It began as a news-sentiment reader and grew into a small autonomous trading-research platform — one that audits itself after every close and tells you where its own numbers can't be trusted yet.

---

## Features

### Research
- **Multi-source news** — aggregates and de-duplicates articles from Finnhub, Marketaux, Alpha Vantage, Tiingo, Alpaca (Benzinga), and Google News, linked to your watched tickers.
- **LLM sentiment** — scores each stock's news via OpenRouter with structured output and an evidence-weighted blend (−1…+1, plus a summary, key driver, and confidence).
- **Quant analysis** — technical indicators (RSI, SMAs, MACD, Bollinger bands, ATR, 30-day volatility, momentum, volume ratio, relative strength, earnings proximity, …) condensed into a quant score.
- **Combined estimate** — fuses sentiment + quant into one signal (`STRONG_SELL … STRONG_BUY`) with a confidence weight, refreshed whenever newer sentiment lands.
- **Insider trades** — SEC Form 4 activity (Finnhub + SEC EDGAR), buy-biased and noise-filtered, with a C-suite read.
- **Congressional trades** — US STOCK Act disclosures (AInvest), per ticker.
- **Private companies** — tracks pre-IPO names and the news attached to them, alongside the listed watchlist.

### Trading — signal performance
- **Paper trading** — acts on the app's own daily signals with simulated long-only, confidence-weighted trades on an Alpaca **paper** account.
- **Per-signal attribution** — internal mark-to-market *sim books* for sentiment / quant / combined, so you can see *which* source predicts best (held constant sizing → only the signal differs).
- **Risk management** — optional risk-managed book variants (hard stop-loss, trailing stop, confirmed-signal exit, signal-decay exit, time stop, ATR-scaled stops) and, on the live book, **broker-enforced** GTC stop / trailing orders so protective exits run continuously instead of once a day.
- **Portfolio-level controls** — gross-exposure, per-name and correlation-cluster caps, a drawdown kill-switch that de-risks before it halts, and an SPY-based regime filter.
- **Performance dashboard** — admin-only equity curves, per-source hit-rate, open positions, and order history.
- **Strategy config in the DB** — the numeric knobs (exit ladder, sizing, portfolio caps) are edited at **/dashboard/admin → Trading strategy** and apply on the next run, no redeploy. Env vars remain as break-glass overrides.
- **Decision trees** — the open / gate / close / broker logic drawn out in `strategy_diagrams/`.

### Self-audit
- **Daily post-close review** — ~1h after the close the app replays its own decisions and checks them against its own rules (exit-rung invariants, broker-vs-sim reconciliation, pipeline health), then emails admins and publishes to `/dashboard/review`. Optionally interprets the findings with an LLM and posts to Slack.
- **Calibration harness** — measures whether stated confidence means anything (reliability diagram, Brier score) at `/dashboard/calibration`; optionally feeds back into position sizing.
- **Improvement agent** — `improve.yml` picks one code-addressable finding from the review and opens a fix PR. CI gates it; a human merges.

### Platform
- Per-user **watchlists** and **market** preferences; **invitation-gated** sign-up; an **admin** role.
- **Email alerts** (Resend) on signal changes.
- Optional per-user **rate limiting** on search + mutation routes (Upstash Redis; no-ops when unset).
- Dark/light theming, Vercel **Web Analytics** + **Speed Insights**, **Sentry** error tracking, and structured (Axiom) logging.

---

## Tech stack

- **Next.js 16** (App Router) · **React 19** · **TypeScript**
- **Tailwind CSS v4** · **shadcn/ui** (Radix) · **lucide-react** · **Recharts** · **sonner**
- **Prisma 7** + `@prisma/adapter-pg` → **Supabase Postgres**
- **Clerk** authentication
- **Sentry** + a custom **Axiom** logger · **Vercel Analytics / Speed Insights**
- **Vitest** (unit) · **Playwright** (e2e) · Testing Library
- Deployed on **Vercel**; the pipeline is orchestrated by **GitHub Actions**, with **Supabase pg_cron** driving the time-critical (market-hours) triggers

---

## Architecture

### The data pipeline
Work is split into small, resumable **stages**, each exposed as a serverless route under `src/app/api/pipeline/<stage>`:

| Workflow | Stages |
|---|---|
| `pipeline.yml` (every ~3h) | `news → sentiment → quant → estimate → paper`, plus `calibrate` |
| `insider.yml` | `insider`, `congress`, `private-companies` |
| `review.yml` | `review` (backup trigger — see below) |

Each stage:

- takes a **240s wall-clock budget** (`PIPELINE_STAGE_BUDGET_MS`, kept under the 300s function timeout) and processes a slice per call, **resuming on the next** — this is how the heavy LLM/news work beats the serverless timeout;
- is **idempotent per UTC day**, so re-runs within a day are cheap no-ops;
- takes a **lease** (`PipelineLease`) for mutual exclusion, because the per-day marker is a read-then-act check and two triggers do land on the same minute;
- isolates per-ticker failures so one bad symbol never sinks a run.

`.github/workflows/pipeline.yml` loops each stage's HTTP endpoint until it reports `done`. The all-in-one `runPipeline()` (and `/api/pipeline/run`) is kept for local debugging and the admin "run now" trigger.

**Time-critical triggers run on Supabase pg_cron, not GitHub Actions.** GH cron drift (+69 min observed on 2026-07-02) can miss a 30-minute trade window entirely, and fixed UTC entries can't hit early-close days. So the **paper** stage's primary trigger is a pg_cron tick every 5 min, 16:00–21:59 UTC weekdays, and the **review**'s is `daily-review-tick`; both stages self-gate to the right window using the broker calendar. The GH entries (`pipeline.yml` near-close runs, `review.yml`) remain as backup — idempotency makes the overlap safe.

### Data model
Analysis is **global per stock**, not per user: a single `Stock` row (unique by ticker) carries all of its `Sentiment`, `QuantAnalysis`, `StockEstimate`, insider, and congress data. `UserStock` simply links a user to a shared stock, and the pipeline runs over the **union of every watchlist**. So a second user who watches an already-tracked ticker inherits its full history immediately. Core models: `Stock`, `Article` / `ArticleStock`, `Sentiment`, `QuantAnalysis`, `StockEstimate`, `Alert`, `EtfProfile`, `InsiderTransaction` / `InsiderSummary`, `CongressTrade`, `PrivateCompany` / `PrivateCompanyArticle`, `PaperOrder` / `SimPosition` / `PaperEquitySnapshot`, `CalibrationSnapshot`, `DailyReview`, `PipelineLease`, plus `User`, `Invitation`, `UserStock`, `Market` / `UserMarket`, `AppSetting`.

### Auth & access
**Clerk** handles auth; sign-up is **invitation-gated** (`Invitation`), and an **admin** role gates operator views (the Performance dashboard and Admin page). All tables ship with **Row Level Security enabled / no policies** — the app connects as the Postgres role (which bypasses RLS), so RLS exists to deny Supabase's Data API by default.

### Dashboard
The sidebar is grouped to make the app's two halves obvious: **Market Research** (News Feed, Markets, Watchlist, Sentiment, Insider, Private Companies) → **Signals** (Analysis, Watchlist Insights) → **Automated Trading** (Portfolio, Performance, Daily Review, Calibration — the whole section is admin-only) → **Account** (Settings, Admin), with an Overview on top.

---

## Getting started

### Prerequisites
- **Node 24** (LTS)
- A **Supabase** Postgres database (or any Postgres) and a **Clerk** application
- An **OpenRouter** API key for sentiment; data-source keys are mostly optional (a source with no key is skipped)

### Setup
```bash
# 1. Install
npm install

# 2. Configure — copy the example and fill in your values
cp .env.example .env

# 3. Database — generate the client + apply migrations, then seed markets/stocks
npx prisma generate
npx prisma migrate deploy   # or `migrate dev` against a scratch DB
npm run db:seed

# 4. Run the dev server
npm run dev
```
Open http://localhost:3000.

Trigger the pipeline locally from the **Settings** page ("run now"), via `POST /api/pipeline/run`, or with `tsx scripts/run-pipeline-debug.ts`.

> **Heads-up:** `npm run build` runs `prisma migrate deploy` against the configured database (it's the Vercel build command). To type/route-check a build **without** touching the DB, run `npx next build`.

### Environment variables
See **`.env.example`** for the full, annotated list. The essentials:

| Group | Vars |
|---|---|
| Database | `DATABASE_URL` (pooled, :6543), `DIRECT_URL` (direct, :5432) |
| Auth | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, sign-in/up URLs |
| App URL | `APP_URL` (where invitation emails land; falls back to `VERCEL_URL`, then the request origin) |
| Sentiment LLM | `LLM_API_KEY`, `VLLM_MODEL`, `VLLM_URL` (OpenRouter) |
| Data sources | `FINNHUB_API_KEY`, `MARKETAUX_API_KEY`, `ALPHAVANTAGE_API_KEY`, `TIINGO_API_KEY`, `COINGECKO_API_KEY`, `ALPACA_API_KEY_ID/SECRET`, `AINVEST_API_KEY`, `SEC_USER_AGENT` (most optional) |
| Pipeline | `PIPELINE_SECRET`, `CRON_SECRET`, plus optional pacing (`PIPELINE_STAGE_BUDGET_MS`, `PIPELINE_*_CONCURRENCY`, `PIPELINE_LEASE_TTL_SECONDS`) |
| Paper trading | `ALPACA_PAPER_API_KEY_ID/SECRET`, plus the `PAPER_*` feature flags |
| Daily review | `SLACK_WEBHOOK_URL` (gates the whole interpret-and-post step), `REVIEW_LLM_MODEL`, window knobs |
| Email / Observability | `RESEND_API_KEY` + `ALERT_FROM_EMAIL` (both needed, or sends no-op), `SENTRY_DSN`, `AXIOM_TOKEN`/`AXIOM_DATASET` |
| Rate limiting | `UPSTASH_REDIS_REST_URL`/`_TOKEN` (auto-detected if provisioned via the Vercel integration; unset = limiter off) |

---

## Paper trading / signal performance

The paper stage answers "how predictive are our signals?" by trading them — long-only, US equities, confidence-weighted — and tracking hypothetical P&L per signal source. It's app-level (one shared operator-owned Alpaca **paper** account, not per-user) and **admin-only**. The sim books run with no keys at all; the live Alpaca book needs the paper keys.

Behavior is layered behind **off-by-default** flags, so deploying changes nothing until you opt in:

| Flag | Effect |
|---|---|
| `PAPER_RISK_BOOKS=1` | Run the risk-managed `*_RM` sim books (stop-loss / trailing / confirmed-signal / decay / time-stop / ATR-scaled), alongside the untouched pure attribution books. Master switch for everything below. |
| `PAPER_RISK_LIMITS=1` | Gate fresh buys behind the book-level caps: gross exposure, per-name, correlation-cluster, and a drawdown kill-switch that de-risks before it halts. |
| `PAPER_BROKER_STOPS=1` | Push the live book's protective exits to Alpaca as native **GTC stop / trailing** orders (continuous, intraday enforcement); entries become whole-share marketable-limit + OTO stop. |
| `PAPER_TRADE_NEAR_CLOSE=1` | Only trade in the final minutes before the US close (deep liquidity; close-aligned marks). |
| `PAPER_LIVE_QUOTES=1` | In-hours, price every decision/fill/mark off the last **trade** rather than the last stored close — what makes sim and broker P&L comparable at all. Inert outside the session. |
| `PAPER_INSIDER_BOOK=1` | Run the `SIM_INSIDER` event book: enter on an insider cluster-buy alert, hold a fixed multi-week period, exit on expiry. Sim-only. |
| `PAPER_CONF_CALIBRATION=1` | Size and enter the `_RM`/live books with confidence adjusted by the calibration harness's reliability diagram. Self-disables until the data passes its trust gates. |

**The numeric tuning knobs are not env vars.** Stop/trail distances, ATR scaling, exit-run counts, entry gates, sizing and portfolio caps live in the DB (`AppSetting` row `tradingConfig`) and are edited at **/dashboard/admin → Trading strategy**, applying on the next run with no redeploy. Precedence is env var (break-glass) > DB override > code default; out-of-bounds values are rejected rather than clamped. The registry of every knob, its bounds and its env name is `src/lib/trading-config.ts`.

The decision trees for all of this — entry gates, the buy gate, the exit ladder, the broker book — are in **`strategy_diagrams/`**.

---

## Project structure

```
src/
  app/
    (dashboard)/dashboard/   # News, Markets, Watchlist, Sentiment, Insider, Private companies,
                             # Analysis, Insights, Portfolio, Performance, Review, Calibration,
                             # Settings, Admin, stocks/[ticker]
    api/pipeline/<stage>/    # news · sentiment · quant · estimate · paper · calibrate · insider
                             # congress · private-companies · review · run · trigger
    api/...                  # watchlist, stocks/search, settings, admin, markets
  lib/                       # pipeline + domain logic (see below)
    pipeline/                # one module per stage + shared budget/lease helpers
  components/                # UI (shadcn) + charts
prisma/                      # schema.prisma + migrations (incl. the pg_cron jobs) + seed
scripts/                     # db seed, promote-admin, local pipeline debug, alpaca smoke test
strategy_diagrams/           # Excalidraw decision trees for the trading strategy
.github/workflows/           # ci · pipeline · insider · review · improve
```

Key `src/lib` modules: `pipeline/` (stage orchestration), `indicators.ts` (quant), `llm.ts` + `sentiment-blend.ts` (LLM sentiment), `signals.ts` (estimate), `news-sources.ts` / `price-sources.ts` (source adapters), `paper-trading.ts` + `portfolio-risk.ts` + `trading-config.ts` + `alpaca-trading.ts` (the trading strategy), `calibration.ts` + `confidence-calibration.ts` (does confidence mean anything), `daily-review.ts` + `review-interpret.ts` (self-audit), `insider-*` / `edgar.ts` / `congress-trades.ts` / `private-companies.ts` (ownership + pre-IPO data), `alerts.ts` + `email.ts`, `rate-limit.ts`, `logger.ts` + `observability.ts`.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Prisma migrate deploy + generate + `next build` (Vercel build command) |
| `npm run start` | Start the production server |
| `npm test` | Run the unit suite (Vitest) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:e2e` | Playwright end-to-end tests |
| `npm run test:e2e:ui` | Playwright in UI mode |
| `npm run lint` | ESLint |
| `npm run db:seed` | Seed markets / stocks |
| `npm run promote-admin` | Grant a user the admin role |

Other `scripts/`: `run-pipeline-debug.ts` (drive the pipeline locally), `alpaca-smoke.ts` (check the paper credentials reach Alpaca), `encode-password.ts`, `pick-finding.ts` (used by `improve.yml`) — all via `tsx`.

---

## Deployment

Deployed on **Vercel** (Hobby-tier friendly: the staged pipeline + GitHub Actions avoid the need for Pro cron — `vercel.json` declares none). Set the environment variables in the Vercel project **and** in the GitHub Actions **Production** environment (the workflows call the deployed stage endpoints with `PIPELINE_SECRET`). Migrations apply automatically during the Vercel build (`prisma migrate deploy`).

The time-critical triggers are **Supabase pg_cron** jobs created by migrations (`*_paper_near_close_pg_cron`, `*_daily_review_pg_cron`), which read the endpoint secret from **Supabase Vault** — so those are configured in Supabase, not Vercel. See the migrations for the exact job definitions.

---

## Conventions

This repo uses a customized Next.js build — see **`AGENTS.md`** before contributing; read the relevant guide under `node_modules/next/dist/docs/` rather than relying on general Next.js knowledge. Keep changes type-checked (`npx tsc --noEmit`), linted, and tested (`npm test`).
