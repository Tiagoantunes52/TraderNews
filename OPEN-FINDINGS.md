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

- **Entry buffer widened 0.5% → 2%, with the risk coupling fixed.** The buffer is a
  filter on gap direction, so tightness is what selects against winners. But widening it
  alone inflates realised risk: the OTO stop is priced at submission off the same stale
  close as the limit, so a top-of-band fill sits `buffer + stopPct` above the stop while
  sizing assumed `stopPct`. At 5% on a 6% ATR-floor stop that is ~1.75x the intended
  risk-per-trade — which is why 2%, not the 5% originally proposed. `planBrokerAction`
  now **re-anchors a fixed stop to the actual fill price** once it is known (trailing
  stops excluded — they trail the peak and never had the problem), with a tolerance so
  the daily stage never cancel/replaces over rounding. Gap distribution behind the
  number (close-to-close, an upper bound since a GTC order rests all day): 40.6% of
  stock-days close >0.5% up, 19.6% >2%, 4.4% >5%.
- **`effectiveTrades` now counts the sample the statistics come from.** It received a
  raw `count()` of closed positions while `edgeTStat`/`alphaTStat` were computed from
  `primaryIndep`, the overlap-pruned set — so the gate could clear its sample-size bar on
  trades contributing no independent evidence. `closedTrades` stays in the report as a
  descriptive figure.
- **`open` added to the daily price contract and persisted.** `DailyPrice.open` across
  all four adapters (Tiingo stock/crypto, Yahoo, Binance, CoinGecko — adjusted open where
  the source has one, close as the documented fallback where it doesn't), plus
  `QuantAnalysis.open` (migration `20260727200000_add_quant_open`, nullable, no
  backfill). No indicator reads it. It is recorded now because modelling next-open fills
  needs open-price history and history has lead time.

- **Live intraday pricing** — `lib/alpaca-quotes.ts`, ship-dark behind
  `PAPER_LIVE_QUOTES=1`. Overlays `priceByStock` (the single map every decision, fill,
  limit reference and mark reads) with the last traded price, so all of them refer to the
  same moment instead of booking a simulated fill at a close the broker can only fill
  after. Last *trade*, not mid or ask — the only one of the three something actually
  transacted at. Uses the MARKET DATA keys (`ALPACA_API_KEY_ID`/`_SECRET`, as the News
  API does), not the paper trading keys. Guards: only while the session is open (outside
  it the "latest trade" is an extended-hours print — neither the official close the rest
  of the app uses nor the price the next order gets); per-stock fallback to the stored
  close so a partial feed response degrades name-by-name rather than splitting a run
  across two pricing regimes; never throws, because a quote feed must not be able to stop
  the stage managing open positions. `flags.liveQuotes` in the run log marks which regime
  produced a given day — days on either side are not comparable.

  **Still open after this:** signal staleness. `sentiment.ts` / `quant.ts` compute once
  per UTC day, so an in-hours run prices against the live tape but still acts on scores
  built from this morning's data. Re-running sentiment near the close means LLM calls
  over the whole universe inside a 300s budget, which is a separate piece of work.

- **Fills are now the primary evidence.** The go-live gate certified
  `SIM_COMBINED_RM` — a book that never paid a spread, never missed a fill and never had
  an order rest unfilled for a month. Those are exactly the points where sim and broker
  diverge, and one-sidedly: the sim books trades the broker could not execute, and the
  ones it could not execute were disproportionately the winners. `selectGatedBook()`
  (pure, tested) now certifies the **broker's** book whenever one exists, and a sim book
  only before any broker history does. A *short* live history deliberately does not fall
  back to the sim — it is judged as the short live record it is and fails on coverage.
  Round-trips are counted as SELL orders that actually **filled**, not sim closes. Gate
  coverage is measured from the gated book's own snapshot span rather than from the age
  of the estimate data, so a book that starts trading later is not credited with history
  it does not have. The sim books remain in the report as diagnostics.
- **Gate enforcement — resolved as "the boundary enforces, the gate reports."** Wiring
  the gate into the order path would have halted the paper book (it reads
  INSUFFICIENT_DATA), and the paper book is the only thing generating the history the
  gate needs — it would have permanently prevented itself from being satisfiable.
  Meanwhile its actual subject, real money, is already unreachable via `baseUrl()`, which
  is a stronger guarantee than a status check: a code-level boundary rather than a value
  that must be computed correctly and then respected. This reasoning is recorded in
  `calibration.ts` above `GATE_THRESHOLDS` so it is not "fixed" by a later reader.

---

## Priority plan

### 1. Rotation policy — the last open item, and deliberately still open

The portfolio cap is *admission control*, not portfolio construction: held names keep
their slots while stronger current candidates are turned away. The ranking change
allocates *free* slots well; it never evicts a holding for a better candidate.

That may be the right strategy — but then it is "hold until exit", not "own the best
current signals", and it should be stated and evaluated as such rather than being an
accident of how the gate happens to work.

**Not blocked on effort — blocked on evidence.** Rotation is a strategy change, and the
entire point of everything above it is that strategy changes could not be evaluated:
the sim booked trades the broker never made. That is now fixed, so the right sequence is
to let the corrected pipeline accumulate a few weeks of fill-based history, then decide
rotation against evidence instead of intuition. Deciding it now would be the same
mistake this register was written to stop.

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
  free slot. It never evicts a held name for a stronger candidate — see item 1.
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
