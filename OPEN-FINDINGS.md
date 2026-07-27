# Open findings register

Joint review of the paper-trading / execution path, **2026-07-27**. Produced by Claude
Code and Codex reviewing independently and then reconciling; every item below was
verified against the code, and the empirical ones against production data.

This file exists so the work survives the session that found it. **Delete an item when
it ships** (and, per convention, summarise the behaviour change into the Obsidian vault
at `~/projects/TraderNews-Vault`). Delete the whole file when it's empty.

Line numbers are hints — trust the symbol names, they rot slower.

---

## The one-sentence verdict

Nothing here shows the strategy is unprofitable. It shows **the system cannot yet
measure whether the strategy is investable**, because the sim records trades the broker
never executed and the broker holds orders the strategy no longer wants. (Precisely: the
sim remains a valid measure of the model's hypothetical close-to-close behaviour. What
it cannot establish is *executable* performance — and only the latter is evidence.)

---

## Shipped

- **Ranked `_RM` entry allocation** — `a3a720c` on `dev`. Slots go to the best-scoring
  candidates rather than whatever the estimate query returned first, and same-run exits
  now free slots for same-run entries. Follow-up in the same area: `rankEntryCandidates`
  now sorts via a finite-safe comparator, because `b.score - a.score` returns `NaN`
  against a non-finite score and a `NaN` comparator result makes sort order
  implementation-defined — which would have broken run-log replay determinism.
- **Plan item 1 — stale entry expiry.** `shouldExpireEntryOrder()` (pure, in
  `paper-trading.ts`) + enforcement in the pending-order reconcile loop. Unfilled BUYs
  are cancelled once `PAPER_ENTRY_ORDER_TTL_DAYS` (default 1) has passed, so an order
  gets its next session and no more. SELLs are exempt at any age — an unfilled exit
  still wants to happen, and cancelling one would strand a position the strategy has
  already decided to leave. Counted as `entryOrdersExpired` on the stage result and in
  the run log. The nine 28–33-day-old orders are cancelled by the first run that sees
  them; no manual intervention needed.
- **Paper/live safety boundary** (was deferred; promoted on Codex's review). `baseUrl()`
  now refuses any `*.alpaca.markets` host that isn't `paper-api`. Non-Alpaca hosts still
  pass so tests can use stubs. Deliberately **no env escape hatch** — an override would
  restore the exact foot-gun being closed. Trading live must be a reviewed code change.
- **Plan item 2 — durable order intents.** `PaperOrder.clientOrderId` is assigned and
  persisted *before* submission and sent to Alpaca as `client_order_id`. All eleven
  submission sites now go through one `submitTracked()` wrapper: write intent
  (`PENDING_SUBMIT`) → submit under the key → record the broker id. A crash in between
  leaves a recoverable row, and a startup sweep resolves it by asking Alpaca for the key
  (found → adopt the real id; a definite 404 → `ABANDONED`; an *error* leaves it pending,
  because guessing would hide a live order). Alpaca also rejects a duplicate
  `client_order_id`, so a retry cannot double-submit. Counted as `intentsRecovered`.
  Two exceptions, both deliberate: OTO stop legs arrive with their parent and so cannot
  be independently duplicated, and the orphan-exit sweep can hit a symbol with no
  `Stock` row, where no intent is storable (`stockId` is required) — that one submission
  stays unrecorded, as before.
- **Plan item 3 — run lease + partial unique index.** `PipelineLease` with a single
  atomic upsert that only steals an *expired* lease (`lib/pipeline-lease.ts`), wrapping
  the whole stage — including the marker read, which is what makes read-then-act atomic.
  Fails open if the lease table is unreachable. The per-day marker is untouched and
  still written last. Plus the partial unique index on `SimPosition`, with a `DO` block
  that fails loudly and names the offending rows rather than letting `CREATE INDEX`
  raise something opaque.

  **The migration is written but NOT applied** — `20260727190000_add_pipeline_lease`.
  Its precheck was validated read-only against prod (no duplicate OPEN rows as of
  2026-07-27), but applying it is a deploy decision.

---

## Priority plan

### 1. Widen `ENTRY_LIMIT_BUFFER_PCT` — interim mitigation only

`paper-trading.ts:206`, currently `0.005`. Widening (~0.05) keeps the OTO+GTC
architecture untouched and collapses most of the selection bias in item 2.

Honest caveat: this is asymptotic, not a fix. It is weakest exactly where it matters,
since names that gap >5% are the high-volatility momentum names that dominate the
unfilled-winners set.

**Do not "just swap to a market order."** The buffered limit is load-bearing:
`submitEntryWithStop` (`alpaca-trading.ts:282`) is `order_class: "oto"` +
`time_in_force: "gtc"` specifically because a market entry forces `day`, which would
expire the attached stop and leave positions naked overnight — the review's own
highest-severity failure mode (`BROKER_STOPS_MISSING`).

### 2. Intraday execution — the structural fix

**Three findings share one root cause: the system decides after the close and executes
against a market that isn't open.**

- Near-close runs use stale signals. `pipeline/sentiment.ts:33` and `pipeline/quant.ts:78`
  both filter `{ none: { date: { gte: todayUTC } } }`, so a stock that already has
  today's row is skipped — a second run never recomputes.
- Fills are *conditional*, producing the winner-selection bias (evidence below).
- Entry orders rest indefinitely (fixed — see Shipped).

You cannot be both unbiased and protected while deciding after the close — every
alternative trades measurement bias against a protection gap. Intraday execution
(live quote → marketable limit, GTC + OTO, in-hours) resolves all three at once.

Blocker: **the app has no intraday price capability at all.** `price-sources.ts`
exports exactly one function, `getDailyPrices`. The only `currentPrice` in the codebase
is read back from Alpaca *positions* — names already held, not a quote source for names
to buy. This is a new market-data integration, which reframes it from "expensive
nice-to-have" to "the change that resolves the majority of critical findings."

### 3. Measurement correctness

- **Fills become the primary record; sim demoted to diagnostic.** Largely follows from
  1–2. The right split: signal research evaluated against a point-in-time executable
  price model; strategy performance from actual orders, fills, cancels, and exposure.
- **`open` missing from the price contract.** `tiingo-prices.ts:3` `DailyPrice` carries
  `{ date, close, volume, high, low }`. Needed to model next-open fills. Adapters,
  persistence and tests all need extending — contained, but more than a column.
- **Gate is not enforced.** `evaluateGate` is imported only by `calibration.ts`,
  `calibration-data.ts` and its test. Nothing in the order path checks it.
- **`effectiveTrades` is wrong.** `calibration.ts:439` documents `minTrades: 30` as
  "non-overlapping round-trips", but `calibration-data.ts:353` passes a raw
  `count()` of all closed positions. `effectiveSampleSize()` — which computes exactly
  the right number — sits at `calibration.ts:430`, unused by the gate. Currently masked
  (`minMonths: 6` fails first at ~1.3 months of data) so it cannot produce a false GO
  today, but it will once coverage passes.
- **Rotation policy.** The cap is *admission control*, not portfolio construction: held
  names keep slots while stronger current candidates are rejected. That may be
  intentional — but then the strategy is "hold until exit", not "own the best current
  signals", and should be evaluated as such. Decide *after* measurement is trustworthy.
  See "known gaps" — the ranking change does **not** address this.

---

## Confirmed but deliberately deferred

These are verified defects that lost the prioritisation, not open questions. They are
listed so they are not silently forgotten.

- **Exits fire on NEUTRAL.** `isExitSignal = !isEntrySignal` (`paper-trading.ts:218`),
  so the book exits on NEUTRAL as well as SELL. Causes churn without a demonstrated
  edge.
- **Env break-glass bypasses bounds validation.** `envValue()`
  (`trading-config.ts:127`) accepts any finite number, while DB-sourced overrides get
  range-checked and dropped on violation. A typo in an env var silently installs a
  nonsensical risk parameter.
- **Missing-fresh-estimate positions go unmanaged.** The paper stage loads only
  estimates dated today and only open positions for those stock ids, so a name without
  a fresh estimate is neither marked nor exited. Verified **zero occurrences in prod**
  (all 151 open positions marked 2026-07-24), so this is latent, not active — but
  unguarded.

---

## Strategy thread (predates the execution review)

- **Hold every tuning knob at its default.** There is no `tradingConfig` row; all knobs
  are at code defaults, and that is currently correct. `exitReason` only began
  persisting **2026-07-21**: 163 of 176 closed `_RM` positions are `UNRECORDED`, leaving
  13 labelled exits. Tuning the exit ladder against that is fitting noise. `entryScore`
  exists on only 59 closes and is non-monotonic across buckets. Revisit after ~4–6 weeks
  of labelled exits.
- **The real signal is payoff, not hit rate.** Across 176 `_RM` trades: hit rate
  55–62% (good), payoff 0.54–0.66, losses ~1.6× winners. Classic cut-winners-short
  signature, consistent across three independent books. Cannot be attributed to a
  specific exit rung until `exitReason` accumulates.
- **The 15-session entry freeze.** `SENTIMENT_RM` and `COMBINED_RM` took zero entries
  2026-07-01 → 07-24; 100% of intended entries vetoed. Cause: `maxPositions: 12`
  evaluated against the *run-start* position count, with books seeded at 83/94 names
  before the limits were switched on. Self-resolving as they drain, and the ranking
  change lets same-day exits free slots for same-day entries.

---

## Known gaps in what has shipped

- **The ranking work has unit tests only.** Nothing proves end-to-end that a same-run
  `_RM` close frees capacity, that the highest-ranked later candidate is the one
  persisted, and that it mirrors to the live book correctly. `runPaperStage` has no
  test harness at all, which is why the pure helpers were extracted — but the
  integration path remains unverified.
- **Ranking allocates, it does not rotate.** It decides which *new* candidate wins a
  free slot. It never evicts a held name for a stronger candidate — see item 3.
- **The live mirror is still updated before the DB write.** `combinedRmOpened` /
  `combinedRmLong` are set before `simPosition.create`, so a write failure can leave
  the broker targeting an intended-but-unpersisted position. Pre-existing behaviour,
  deliberately preserved by the ranking change rather than silently altered.

ESLint is broken repo-wide (eslint-plugin-react version detection under ESLint 10) and
fails identically on untouched files, so none of this work could be linted.

---

## Evidence appendix

Derived from production 2026-07-27; keep so a future session need not re-derive it.

**Entry fills vs the sim's assumed close** (58 matched `COMBINED_RM` BUYs):

| metric | value |
|---|---|
| mean | −89.4 bps |
| median | −24.2 bps |
| mean absolute | 122.2 bps |
| worst | −653.2 bps |
| best | **+50.0 bps** (hard cap = the 0.5% buffer) |
| fills pinned at the cap | 15 / 58 |
| gapped down >100 bps | 20 / 58 |

The asymmetry is the whole story: fills cap at +50 bps but run to −653. A buy limit at
`close × 1.005` fills when a name gaps *down* and fails when it gaps *up*.

**The unfilled orders are the winners.** Nine never-filled BUYs with a matching sim
position:

| MA | PANW | TMO | UNH | VRTX | TOST | GE | MRK | NEE |
|---|---|---|---|---|---|---|---|---|
| +6.3% | +9.4% | +16.3% | +4.4% | +2.5% | +15.9% | −0.9% | +1.0% | +2.3% |

**8 of 9 winners, averaging +6.3%**, against a book average of **−0.35%**. On the fills
alone the live book entered 0.89% *cheaper* than the sim — so the sim's advantage comes
entirely from counting trades that were never executable. This is adverse selection, not
slippage; fixing "slippage" would not touch it.

Mean absolute execution divergence (1.2%/trade) is roughly a third of the average winner
(3.3%). **The measurement error is a large fraction of the signal**, so more sim history
does not help.

```sql
-- fill vs sim entry
select s.ticker, ((o."filledAvgPrice"-p."entryPrice")/p."entryPrice")*10000 bps
from "PaperOrder" o join "Stock" s on s.id=o."stockId"
join "SimPosition" p on p."stockId"=o."stockId"
  and p."entryDate"::date=o."submittedAt"::date and p.strategy='COMBINED_RM'
where o.side='BUY' and o."filledAvgPrice" is not null;

-- resting entry orders
select s.ticker, o.status, (current_date - o."submittedAt"::date) days_resting
from "PaperOrder" o join "Stock" s on s.id=o."stockId"
where o.side='BUY' and o.status='new' order by o."submittedAt";
```
