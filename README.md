# TraderNews

TraderNews turns a noisy stream of financial news into an opinion — then measures whether that opinion is any good. For the stocks and crypto you watch it aggregates news, scores each name with **LLM sentiment** and **quantitative technical analysis**, blends them into a single BUY/SELL signal, layers in **insider** and **congressional** trading activity, and runs an autonomous **paper-trading** book that tracks how predictive each signal source actually is.

It began as a news-sentiment reader and grew into a small autonomous trading-research platform.

---

## Features

### Research
- **Multi-source news** — aggregates and de-duplicates articles from Finnhub, Marketaux, Alpha Vantage, Tiingo, Alpaca (Benzinga), and Google News, linked to your watched tickers.
- **LLM sentiment** — scores each stock's news via OpenRouter with structured output and an evidence-weighted blend (−1…+1, plus a summary, key driver, and confidence).
- **Quant analysis** — technical indicators (RSI, SMAs, MACD, Bollinger bands, ATR, 30-day volatility, momentum, volume ratio, relative strength, earnings proximity, …) condensed into a quant score.
- **Combined estimate** — fuses sentiment + quant into one signal (`STRONG_SELL … STRONG_BUY`) with a confidence weight, refreshed whenever newer sentiment lands.
- **Insider trades** — SEC Form 4 activity (Finnhub + SEC EDGAR), buy-biased and noise-filtered, with a C-suite read.
- **Congressional trades** — US STOCK Act disclosures (AInvest), per ticker.

### Trading — signal performance
- **Paper trading** — acts on the app's own daily signals with simulated long-only, confidence-weighted trades on an Alpaca **paper** account.
- **Per-signal attribution** — internal mark-to-market *sim books* for sentiment / quant / combined, so you can see *which* source predicts best (held constant sizing → only the signal differs).
- **Risk management** — optional risk-managed book variants (hard stop-loss, trailing stop, confirmed-signal exit, time stop, ATR-scaled stops) and, on the live book, **broker-enforced** GTC stop / trailing orders so protective exits run continuously instead of once a day.
- **Performance dashboard** — admin-only equity curves, per-source hit-rate, open positions, and order history.

### Platform
- Per-user **watchlists** and **market** preferences; **invitation-gated** sign-up; an **admin** role.
- **Email alerts** (Resend) on signal changes.
- Dark/light theming, Vercel **Web Analytics** + **Speed Insights**, **Sentry** error tracking, and structured (Axiom) logging.

---

## Tech stack

- **Next.js 16** (App Router) · **React 19** · **TypeScript**
- **Tailwind CSS v4** · **shadcn/ui** (Radix) · **lucide-react** · **Recharts** · **sonner**
- **Prisma 7** + `@prisma/adapter-pg` → **Supabase Postgres**
- **Clerk** authentication
- **Sentry** + a custom **Axiom** logger · **Vercel Analytics / Speed Insights**
- **Vitest** (unit) · **Playwright** (e2e) · Testing Library
- Deployed on **Vercel**; the data pipeline is orchestrated by **GitHub Actions**

---

## Architecture

### The data pipeline
Work is split into small, resumable **stages**, each exposed as a serverless route under `src/app/api/pipeline/<stage>` (`news → sentiment → quant → estimate → paper`, plus `insider` and `congress` on a separate workflow). Each stage:

- has its own ~300s serverless budget and processes a slice per call, **resuming on the next** — this is how the heavy LLM/news work beats the serverless timeout;
- is **idempotent per UTC day**, so re-runs within a day are cheap no-ops;
- isolates per-ticker failures so one bad symbol never sinks a run.

A **GitHub Actions** workflow (`.github/workflows/pipeline.yml`) drives the stages on a cron (every ~3h, plus near-close windows for trading), looping each stage's HTTP endpoint until it reports `done`. The all-in-one `runPipeline()` (and `/api/pipeline/run`) is kept for local debugging and the admin "run now" trigger.

### Data model
Analysis is **global per stock**, not per user: a single `Stock` row (unique by ticker) carries all of its `Sentiment`, `QuantAnalysis`, `StockEstimate`, insider, and congress data. `UserStock` simply links a user to a shared stock, and the pipeline runs over the **union of every watchlist**. So a second user who watches an already-tracked ticker inherits its full history immediately. Core models: `Stock`, `Article` / `ArticleStock`, `Sentiment`, `QuantAnalysis`, `StockEstimate`, `Alert`, `InsiderTransaction` / `InsiderSummary`, `CongressTrade`, `PaperOrder` / `SimPosition` / `PaperEquitySnapshot`, plus `User`, `Invitation`, `UserStock`, `Market` / `UserMarket`, `AppSetting`.

### Auth & access
**Clerk** handles auth; sign-up is **invitation-gated** (`Invitation`), and an **admin** role gates operator views (the Performance dashboard and Admin page). All tables ship with **Row Level Security enabled / no policies** — the app connects as the Postgres role (which bypasses RLS), so RLS exists to deny Supabase's Data API by default.

### Dashboard
The sidebar is grouped to make the app's two halves obvious: **Market Research** (News, Markets, Watchlist, Sentiment, Insider) → **Signals & Portfolio** (Analysis, Portfolio) → **Trading** (Performance, admin) → **Account** (Settings, Admin), with an Overview on top.

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
| Sentiment LLM | `LLM_API_KEY`, `VLLM_MODEL`, `VLLM_URL` (OpenRouter) |
| Data sources | `FINNHUB_API_KEY`, `MARKETAUX_API_KEY`, `ALPHAVANTAGE_API_KEY`, `TIINGO_API_KEY`, `COINGECKO_API_KEY`, `ALPACA_API_KEY_ID/SECRET`, `AINVEST_API_KEY`, `SEC_USER_AGENT` (most optional) |
| Pipeline | `PIPELINE_SECRET`, `CRON_SECRET` |
| Paper trading | `ALPACA_PAPER_API_KEY_ID/SECRET`, plus the optional `PAPER_*` knobs |
| Email / Observability | `RESEND_API_KEY`, `SENTRY_DSN`, `AXIOM_TOKEN`/`AXIOM_DATASET` |

---

## Paper trading / signal performance

The paper stage answers "how predictive are our signals?" by trading them — long-only, US equities, confidence-weighted — and tracking hypothetical P&L per signal source. It's app-level (one shared operator-owned Alpaca **paper** account, not per-user) and **admin-only**. The sim books run with no keys at all; the live Alpaca book needs the paper keys.

Behavior is layered behind **off-by-default** flags, so deploying changes nothing until you opt in:

| Flag | Effect |
|---|---|
| `PAPER_RISK_BOOKS=1` | Run the risk-managed `*_RM` sim books (stop-loss / trailing / confirmed-signal / time-stop / ATR-scaled), alongside the untouched pure attribution books. |
| `PAPER_BROKER_STOPS=1` | Push the live book's protective exits to Alpaca as native **GTC stop / trailing** orders (continuous, intraday enforcement); entries become whole-share marketable-limit + OTO stop. |
| `PAPER_TRADE_NEAR_CLOSE=1` | Only trade in the final minutes before the US close (deep liquidity; close-aligned marks). |

The `PAPER_*` tuning knobs (stop %, trail %, ATR multiple, window minutes, …) all have sensible defaults — see `.env.example`.

---

## Project structure

```
src/
  app/
    (dashboard)/dashboard/   # News, Markets, Watchlist, Sentiment, Insider,
                             # Analysis, Portfolio, Performance, Settings, Admin, stocks/[ticker]
    api/pipeline/<stage>/    # news · sentiment · quant · estimate · insider · congress · paper · run · trigger
    api/...                  # watchlist, stocks/search, settings, admin, markets
  lib/                       # pipeline + domain logic (see below)
  components/                # UI (shadcn) + charts
prisma/                      # schema.prisma + migrations + seed
scripts/                     # db seed, promote-admin, local pipeline debug
.github/workflows/           # pipeline cron orchestration
```

Key `src/lib` modules: `pipeline.ts` (stage orchestration), `indicators.ts` (quant), `llm.ts` + `sentiment-blend.ts` (LLM sentiment), `signals.ts` (estimate), `news-sources.ts` / `price-sources.ts` (source adapters), `paper-trading.ts` + `alpaca-trading.ts` (paper book), `insider-*` / `edgar.ts` / `congress-trades.ts` (ownership data), `alerts.ts` + `email.ts`, `logger.ts` + `observability.ts`.

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
| `npm run lint` | ESLint |
| `npm run db:seed` | Seed markets / stocks |
| `npm run promote-admin` | Grant a user the admin role |

---

## Deployment

Deployed on **Vercel** (Hobby-tier friendly: the staged pipeline + GitHub Actions avoid the need for Pro cron). Set the environment variables in the Vercel project **and** in the GitHub Actions **Production** environment (the workflow calls the deployed stage endpoints with `PIPELINE_SECRET`). Migrations apply automatically during the Vercel build (`prisma migrate deploy`).

---

## Conventions

This repo uses a customized Next.js build — see **`AGENTS.md`** before contributing; read the relevant guide under `node_modules/next/dist/docs/` rather than relying on general Next.js knowledge. Keep changes type-checked (`npx tsc --noEmit`), linted, and tested (`npm test`).
