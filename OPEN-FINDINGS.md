# Open findings register

Joint review of the paper-trading / execution path, **2026-07-27**. Produced by Claude
Code and Codex reviewing independently and then reconciling; every item below was
verified against the code, and the empirical ones against production data.

This file exists so the work survives the session that found it. **Delete an item when
it ships** (and, per convention, summarise the behaviour change into the Obsidian vault
at `~/projects/TraderNews-Vault`). Delete the whole file when it's empty.

Line numbers are hints — trust the symbol names, they rot slower.

## This file checks itself

Several claims below are empirical — "there is no `tradingConfig` row", "verified zero
occurrences in prod", "13 labelled exits". Each is really a query someone ran once, and
prose cannot notice when it stops being true. So they are also written as assertions in
`src/lib/findings-register.ts`, re-run by the daily review, and a broken one becomes a
**`REGISTER_STALE`** finding naming the bullet to edit.

Claims that are checked carry an `<!-- check: <id> -->` marker naming their assertion.
**Staleness is not failure** — most of these expire by being *fixed*, and the finding is
the prompt to delete the bullet. If you edit a marked claim, edit its assertion in the
same commit; if you delete the bullet, delete the assertion. An assertion with no bullet
is worse than neither, because it reports on a document that no longer says it.

Claims about *code* rather than data are deliberately not encoded — "exits fire on
NEUTRAL" would be a second, worse copy of `paper-trading.ts`.

Counts quoted in the bullets are **as of the review date in the header** and are not
maintained. The live numbers ride on the daily review's `REGISTER_CHECKED` finding; a
bullet's number is there to show what the judgement was made on, not what is true today.

*First run, 2026-07-30: two claims had already expired* — the pipeline-lease migration
was applied, and the `_RM` entry freeze had drained. Both are corrected below.

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

  **Applied 2026-07-30.** `20260727190000_add_pipeline_lease` is recorded finished in
  prod; its precheck (no duplicate OPEN rows) passed on the real data. The register said
  "written but NOT applied" for three days after it stopped being true — which is the
  reason the self-check below exists.

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
  <!-- check: reanchor-cancels-first -->
  **Correction (2026-07-29): the re-anchor shipped inert and never once executed.** The
  stage submitted the replacement stop without cancelling the one it replaces, and
  Alpaca holds the position's shares against a resting sell order — so every re-place
  was rejected `403 insufficient qty available` (the body's `related_orders` names the
  very stop being replaced) and every mis-anchored stop stayed exactly where it was.
  It failed on 8 of 11 positions on 2026-07-28 alone. `planBrokerAction` now marks the
  re-anchor case `replacesResting`, and the stage cancels first. The realised-risk
  overshoot the 2% cap was sized to tolerate was therefore live and uncorrected for the
  whole period between the two dates.
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

## Confirmed 2026-07-30: the quant entry signal inverted

**Note (2026-08-22): the live QUANT entry excess oscillates around zero — do not read
its sign.** Three readings of the same 90-day live statistic:

| measured | QUANT entry excess | t | n |
|---|---|---|---|
| 2026-07-30 | −38.0 bps | — | — |
| 2026-08-17 | +37.5 bps | — | — |
| 2026-08-22 | −4.5 bps | −0.22 | 480 over 51 sessions |

It has changed sign twice in three weeks and has never once been distinguishable from
noise (|t| ≤ 0.22). This bullet used to be checked here as `quant-signal-inverted`
(`src/lib/findings-register.ts`), asserting `excess < 0` — a bare sign with no
significance test — so it flipped to `REGISTER_STALE` on 2026-08-17 the moment the
number crossed zero, and would have flipped back by 2026-08-22. That check is now
removed rather than re-pointed: re-pointing it at the new sign only rebuilds the same
tripwire facing the other way. **The lesson is the oscillation itself, not any of the
three readings** — which is why none of them is asserted here as fact.

Ongoing monitoring belongs to `signal-health.ts`'s `SIGNAL_INVERTED` (see "Now
monitored" below), which requires t ≤ -2 before firing and so cannot be moved by a
statistic this noisy.

**Correction (2026-08-22, same day):** the sentence above originally read that the
monitor "is demonstrably live and works: it is firing on `COMBINED` (−61.3 bps,
t = −3.96)". That was wrong, and wrong in the direction this whole section warns
about — the alert it cited as proof was itself a false positive. `signalHealth`
computed the entry t-stat by pooling every scored name into one sample, so ~40
same-day names counted as ~40 independent observations when they are one market
move. On the same rows, the honest figures are:

| COMBINED entry excess | t |
|---|---|
| pooled over observations (old) | −3.96 |
| across sessions | −1.27 |
| across sessions, Newey-West (overlapping 5-day windows) | **−0.85** |

Fixed in `entryTStat` (`signal-health.ts`), which now judges significance across
sessions with Newey-West errors; the alert correctly went silent. A train/test split
of the same window (25 vs 26 sessions, split 2026-07-09) puts the COMBINED entry
excess at −49.5 bps (t −1.49) in train and −74.1 bps (t −0.60) in holdout, negative in
4 of 4 rolling folds. **So the sign is persistent but the magnitude is never
distinguishable from zero** — worth watching, not worth acting on. Note the whole
sample is 51 sessions, because `sessionDate` only starts 2026-06-01.

The out-of-sample study below is a separate and much stronger measurement — 119,428
stock-days with a train/holdout split, not one 90-day live window — and is unaffected
by any of this, as are its rejected fixes and the entry/exit split it led to. None of
that depended on the live excess holding a sign.

**`calcQuantScore` is anti-predictive out of sample** (as measured 2026-07-30).
Established over the whole `PriceBar` corpus — **119,428 stock-days, 104 names,
2021-10-25 → 2026-07-22** — as daily cross-sectional IC against 5-day forward returns,
t-stat taken across days (pooling would
inflate N ~100x, since names move together). The measurement was validated before being
trusted: a plumbing control returns IC exactly 1.0000, and 30-day momentum returns
IC 0.0216 at t = 3.10.

Split TRAIN 2021-10 → 2025-01 (801 sessions) vs HOLDOUT 2025-01 → 2026-07 (383):

| | cross-sectional | time-series |
|---|---|---|
| TRAIN | +0.0109 (1.55) | +0.0142 (2.29) |
| HOLDOUT | **-0.0238 (-2.32)** | **-0.0366 (-4.73)** |

Mean 5-day forward return by `scoreToSignal` bucket, against the universe that session:

| bucket | TRAIN n | TRAIN | HOLDOUT n | HOLDOUT |
|---|---|---|---|---|
| STRONG_BUY | 118 | 1.21% | 32 | -0.21% |
| **BUY** | 7,443 | **0.94% (t=6.54)** | 4,231 | **0.21% (t=-3.42)** |
| NEUTRAL | 64,618 | 0.37% | 31,652 | **0.66%** |
| SELL | 7,256 | 0.52% | 4,029 | 0.48% |

Train reads correctly (1.21 → 0.94 → 0.37); holdout reads backwards (-0.21 → 0.21 →
0.66), with NEUTRAL the best bucket. **The BUY signal went from +0.50pp excess to
-0.38pp.** Consistent with the live `QUANT` book's 29.6% hit rate over 81 closes.

**Three structural causes, none of them a single bad term.** Leave-one-out leaves IC
between -0.021 and -0.026 whichever term is removed — every one is dragging.

1. **Nominal weights are fiction.** The terms have wildly different spreads, so the
   designed 30/30/10/10/20 behaves like macd 33.1% / momentum 25.8% / rsi 19.8% /
   bollinger 16.4% / **volume 5.0%**. MACD dominates on the third-largest weight;
   the volume term is inert for ranking purposes.
2. **It leans on the fragile momentum horizon.** `change7d` +0.0116 train,
   **-0.0136 holdout**; `change30d` +0.0227 (t=2.63) train, **+0.0194 (t=1.63) holdout**.
   Momentum did not stop working — the 7-day lookback the score uses is the one that
   broke. This is the only component finding that replicates across both periods.
3. **Nothing was ever fitted.** The weights, the ±20% momentum normaliser, the 0.6/0.2
   `scoreToSignal` cuts are all hardcoded constants validated against nothing. `p99` of
   the score is 0.48, so STRONG_BUY (>0.6) fires 0.08% of the time and NEUTRAL holds 79%
   of the mass: the five-level scale is really three.

**What was tried and rejected.** `calcQuantScore`'s internal RSI regime flip
(`indicators.ts:237-240`, mean-reversion when `|momNorm| < TREND_REGIME_MIN`) looked like
a one-line fix: reading RSI as pure momentum scored t = +2.58 in sample against t = -1.14
for the shipped version. **It did not replicate — t = 2.90 train, 0.35 holdout.** Recorded
because the next reader will have the same idea.

**Do NOT invert or reweight the signal off this.** One holdout period. The finding is
"the score was never fitted and its effective weights do not match its designed weights",
which argues for refitting under train/test discipline — not for flipping a sign, which
has already been tried here and failed. No capital is exposed (`baseUrl()` refuses any
non-`paper-api` host), so the cost is measurement time, not money.

**Now monitored.** `src/lib/signal-health.ts` runs in the daily review and reports each
source's entry-bucket excess over the universe, emitting `SIGNAL_INVERTED` when it turns
significantly negative. That is a prompt to investigate, not a trigger to act.

**The study above is now reproducible.** It originally ran in throwaway scripts that were
deleted; `npm run signal-research` (`src/lib/signal-research.ts`, pure) rebuilds it from
`PriceBar` — daily cross-sectional IC with the t-stat across sessions, time-series IC,
`scoreToSignal` buckets, entry excess over the session universe, fixed split plus rolling
walk-forward, all conditioned on market regime. It models **no fills, sizing, exits, caps
or cash**, so it cannot say a change makes money; it can only say whether one score ranks
names better than another out of sample. Candidates are **pre-registered in
`signal-research-variants.ts`**, so `k` stays honest and the reported noise threshold
means something. Two controls run on every invocation regardless of `--candidates`, and
the driver exits non-zero if they fail: `oracle` must return IC exactly 1.0000, `mom30`
must detect the known momentum effect. A null result off an unverified instrument is
worth nothing.

**Executable frames added 2026-08-24** (`--frame=exec|fill`): entry at the next
session's open, or at a buffered 2%-limit with misses *dropped* — the entry leg the
sim was measured to fantasise about. First read, holdout, close → exec → fill:
baseline IC -0.0277(-2.73) → -0.0243(-2.44) → -0.0238(-2.39); `f2` +0.0034 → +0.0068
→ +0.0055 — **no verdict flips**, so the close-frame conclusions above survive
executability. Entry-bucket fill rate under a resting 2% limit is ~97% (the intraday
low usually crosses back through the limit even after a gap-up open — the close-only
gap distribution quoted earlier was an upper bound on misses, as footnoted at the
time). The instructive control: `mom30`'s holdout IC shrinks +0.0139 → +0.0083 from
close to fill — a meaningful slice of the momentum edge lives in the overnight gap
you cannot buy. The exit leg is still an idealised close; sizing/exits/cash remain
unmodelled.

**First run, 2026-07-31 — all three pre-registered hypotheses FAILED.** Split 2025-01-01,
horizon 5, 801 train / 383 holdout sessions:

| candidate | TRAIN | HOLDOUT | entry excess | verdict |
|---|---|---|---|---|
| `oracle` | +1.0000 | +1.0000 | — | control ok |
| `mom30` | +0.0227 (2.63) | +0.0201 (1.68) | +7.4 bps | control ok |
| `baseline` | +0.0109 (1.55) | **-0.0232 (-2.25)** | -28.2 bps | FAILS |
| `h1-momentum-horizon` | +0.0205 (2.80) | -0.0014 (-0.14) | +6.5 bps | FAILS |
| `h2-no-vol-damper` | +0.0125 (1.62) | -0.0230 (-2.04) | +4.3 bps | FAILS |
| `h3-spread-normalised` | +0.0079 (1.11) | -0.0246 (-2.36) | -13.1 bps | FAILS |

`k=4` → noise threshold |t| ≈ 1.67, which nothing above clears out of sample. **`h1` is
the informative failure:** `change30d` on its own survives the holdout (+0.0201, and 4/4
folds sign-consistent), but dropped into the composite in place of `change7d` it collapses
to -0.0014 and holds sign in only 1/4 folds. The momentum leg is not what is broken — the
composite destroys a leg that works on its own. Swapping single terms is therefore the
wrong move; the blend itself needs refitting.

Holdout by market regime says the same thing louder. `baseline` is **-0.1393 (t=-6.68)**
in `TREND_BEAR` and +0.0336 (1.97) in `MEAN_REVERTING`; every variant repeats that shape.
The score is not uniformly weak — it is actively wrong when the market trends down, which
is where a long-only book takes its losses.

### Refitting the blend, 2026-07-31 — the inversion is fixable, but nothing has earned a ship yet

`npm run signal-research-fit` estimates the weights instead of declaring them:
Fama-MacBeth (one cross-sectional OLS per session, coefficients averaged and t-tested
**across** sessions) on terms standardised over the fitting period. It reads **train
sessions only** — it filters to `session < --split` before it reads anything and prints
the sessions it used — and emits a constant block that is pasted into
`signal-research-variants.ts`. The candidate therefore stays a pure per-row function that
cannot reach the data it was fitted on, and the holdout is scored once, afterwards.

**The train fit alone convicts the designed weights.** Over 797 sessions / 79,464 obs:

| term | designed weight | fitted t |
|---|---|---|
| momentum | 30% | **+3.51** |
| volume | 10% | +1.75 |
| bollinger | 10% | -0.88 |
| rsi | **30%** | +0.65 |
| macd | **20%** | -0.60 |

Half the weight is paid to two terms that fit at |t| < 1. And **MACD flips sign by
regime** — **-4.27** in `TREND_BULL`, **+3.03** in `MEAN_REVERTING` — two significant
effects with opposite signs cancelling to -0.60 globally. That is the same cancellation
that hid the score's regime split, one level down.

Two refits were pre-registered before the holdout saw either:

| candidate | TRAIN | HOLDOUT | folds | entry excess | verdict |
|---|---|---|---|---|---|
| `f1-refit-global` | +0.0099 (1.34) | -0.0091 (-0.85) | 2/4 | +3.2 bps | FAILS |
| `f2-refit-by-regime` | +0.0270 (3.72) | **+0.0068 (0.62)** | **4/4** | +6.6 bps | WEAK |

**`f2` is the first candidate in this entire investigation that does not invert out of
sample**, and the regime table shows where it came from:

| | `baseline` | `f2-refit-by-regime` |
|---|---|---|
| TREND_BULL | -0.0420 (-2.35) | -0.0262 (-1.41) |
| **TREND_BEAR** | **-0.1393 (-6.68)** | **-0.0048 (-0.17)** |
| MEAN_REVERTING | +0.0336 (1.97) | +0.0361 (1.95) |
| entry excess | **-28.2 bps** | **+6.6 bps** |

The catastrophic bear-market inversion is essentially gone. That is a structural result:
the anti-predictiveness was **not** irreducible noise, and it was **not** one bad term —
it was one weight vector being applied to terms whose signs depend on the regime.

**It still does not ship, and nothing here changes a live weight.** Holdout t = 0.62
against a `k=6` noise threshold of **1.89**: `f2` is indistinguishable from no edge. It
buys four times the parameters on a quarter of the sessions each, and the regime label
itself comes from cut-points (ADX 20/25, RSI 30/70) that nobody fitted either. The honest
summary is *"we can stop the score being actively wrong; we have not shown it is right"*.
`f1` failing while `f2` is flat also says the regime conditioning — not the refit — is
what carried it, which is the part worth pursuing next.

### Fitting the regime boundaries, 2026-07-31 — the search won in validation and lost in the holdout

The cut-points were the last unfitted constants in the chain, so `npm run
signal-research-fit -- --boundaries` fits them too, by **nested selection inside train**:
weights fitted on sessions < 2024-01-01, a 116-set grid ranked on the 252 sessions after
it that those weights never saw, then the weights refitted on all of train under the
winner. The holdout saw none of it. `rsiHi` is pinned to `100 - rsiLo` and `adxCalm <=
adxTrend` is enforced, so the grid searches a partition rather than an overlap.

**In validation the textbook numbers looked indefensible.** The shipped
`adx>25 / adx<20 / rsi 30-70` ranked **52nd of 73 usable sets** at +0.0020 (t=0.16). The
winner, `adx>20 / adx<20 / rsi 40-60`, scored +0.0318 (2.61) — and the entire top ten
wanted `adxTrend` at 20-22.5, so this was not one lucky cell.

**It did not transfer.**

| | inner validation | HOLDOUT | folds |
|---|---|---|---|
| `f2-refit-by-regime` (textbook cuts) | +0.0020 (0.16) | **+0.0068 (0.62)** | 4/4 |
| `f3-fitted-regimes` (fitted cuts) | **+0.0318 (2.61)** | **+0.0009 (0.09)** | 4/4 |

**The candidate that won validation by 16x came last out of sample.** It is not a
disaster — `f3` still does not invert, and it beats `f2` in `MEAN_REVERTING` (+0.0429 vs
+0.0361) — but it gives back most of `f2`'s bear-market repair (`TREND_BEAR` -0.0316 vs
-0.0048) and nets out flat.

**This was predicted before the holdout ran, and that is the point.** Searching 116
partitions has a noise threshold of |t| ≈ **3.08**; the winner's validation t was
**2.61**, i.e. already below what the search produces on its own. The selection-adjusted
threshold is not decoration — it called this one in advance, and reading the winner
against zero instead would have shipped a 16x "improvement" that is worth nothing.

**What this settles:** the regime *cut-points* are not where the edge is. Conditioning on
regime **at all** is what moved `TREND_BEAR` from -0.1393 to -0.0048; refining where the
line sits is fitting noise. Stop tuning the boundary. Two conclusions follow — the ADX
20-vs-25 question is closed (it does not matter out of sample), and the remaining
candidates for the next real gain are the term *transforms* (the clamps, the ±20%
momentum normaliser, the RSI regime flip), which are still unfitted, and a longer holdout.

### ACTED ON 2026-07-31: quant dropped from the entry, kept in the exit

The first trading-behaviour change this investigation has produced. `COMBINED_RM` (and
therefore the live Alpaca book that mirrors it) now gates **entry** on the SENTIMENT
score. Its **exit** path still reads the full combined score. Knob:
`combinedEntryUsesQuant` (default **0**; set to 1 to restore, env `PAPER_COMBINED_ENTRY_QUANT`
as break-glass).

**Why the split rather than dropping quant outright.** The harness only ever measured
*ranking* — which name to buy. It never tested when to leave, and the books say those two
questions have different answers:

| | evidence | reading |
|---|---|---|
| ENTRY | Names quant ADDED to COMBINED: **38.8% win, -0.71%/trade** (n=134). Names quant VETOED: **44.5%, -0.00%** (n=146). Welch t = -1.21 | quant's distinctive picks are the worse ones |
| ENTRY | Paired on same name + same day, COMBINED vs SENTIMENT: 42.3% vs 43.0% over 305 pairs | with entry held fixed, quant adds nothing |
| EXIT | Paired `_RM`, same name + same entry day: COMBINED_RM won **4** trades SENTIMENT_RM lost, **0** the other way (58 pairs, McNemar p≈0.125) | can only be the exit path — one-directional |

**Scope, deliberately narrow.** Only the `_RM` books change. The pure `COMBINED` book
keeps the combined entry and stays the untouched attribution baseline, so the change can
be measured against something. Confidence is untouched — quant still moves it, including
the disagreement penalty at `estimate.ts:163`.

**One invariant had to move with it.** The DECAY exit fires when "the conviction that
justified the entry has been gone for N runs", so it now reads the *entry* score too —
otherwise it would stop mirroring the gate it is supposed to mirror. The confirmed-bearish
`SIGNAL` exit deliberately does NOT follow: that one keeps the full combined read, and it
is the leg the paired evidence supported.

**Honesty about the evidence.** The entry result is t = -1.21, and the exit result is 4
discordant events at p ≈ 0.125. Neither is significant. What justifies acting anyway is
the asymmetry: the holdout study is strong evidence that quant ranks badly, and "stop
acting on something shown to be actively wrong" is a lower bar than "start acting on
something new". If the books disagree over the next few months, the knob reverses it.

---

## ACTED ON 2026-07-31: the entry limit was anchored to a two-session-old price

**The exits are not the problem — measure before tuning them.** Post-exit drift over the
10 trading days after every close, excess over SPY: `COMBINED_RM` **-2.97%** (n=44),
`SENTIMENT_RM` -2.02% (n=56), pure books ≈ -0.9%. Every book sells names that then
underperform. The `_RM` ladder is the single biggest positive contributor in the system:
same signals and sizing as pure `COMBINED`, ladder added, and per-trade goes from -0.94%
(439 closes, -$2,494) to +0.04% (81 closes, +$8). **Leave the exits alone.**

**What was still leaking is the entry anchor.** The 2026-07-27 audit fixed the obvious
half — buffer 0.5% → 2%, stale entry orders expire, stops re-anchor after the fill
(cancel-first, 2026-07-29). It missed where the reference price comes from.

`planBrokerAction` prices the limit at `price × (1 + 2%)`, where `price` is the live trade
when the quote overlay covers the name and the latest stored `QuantAnalysis.price`
otherwise.

**The overlay IS on in production.** `PAPER_LIVE_QUOTES=1` is set, and the decision log
confirms it: on 2026-07-30, the only run for which `priceSource` exists, **630 of 630
decisions are `LIVE_TRADE`** and none are `CLOSE`. Estimate-carrying names are therefore
anchored to the tape, not to a stale close.

<!-- An earlier draft of this section claimed the overlay was off, from a query that
     tested `priceSource = 'LIVE'` at the top level. The recorded value is `LIVE_TRADE`
     and it lives inside `inputs`, so the query matched nothing and absence-of-match was
     read as absence-of-feature. Corrected the same day; the code below was already
     written to no-op on live-priced names, so nothing shipped on the bad premise. -->

**The stale-anchor problem is real but narrower than that draft claimed.** It survives
only where the overlay does not reach:

- the **convergence sweep**, which prices names that have no estimate today from
  `lastQuant` and never consults the quote feed — by construction the stalest prices in
  the run;
- any name the feed omits (the overlay falls back per-stock, deliberately);
- any run where the market is closed, or the clock/quote call fails.

For those paths the anchor is genuinely two sessions old: `sessionDate` makes it
measurable rather than arguable, and for all 109 priced names `current_date - sessionDate`
is **2** — `QuantAnalysis` is written ~02:20 UTC about a session that already closed,
while the paper stage acts near the *next* close.

**So the buffer was sized against the wrong distribution.** It was chosen from the ONE-day
gap distribution. Over `PriceBar` since 2025-01-01, the share of moves clearing +2%:

| reference age | miss rate |
|---|---|
| 1 session | 16.7% |
| **2 sessions (production)** | **24.6%** |
| 3 sessions | 29.6% |

Staleness alone inflates the miss rate by half, and a miss is always a name that *ran* —
which is precisely the adverse selection the audit identified, re-entering through the
anchor rather than the buffer.

**Fix shipped:** the entry buffer is scaled by `sqrt(sessions stale)`
(`stalenessScaledBuffer`), with staleness derived per-name from `sessionDate`
(`sessionsStale`, weekday count, capped at 5, unknown treated as maximally stale). Chosen
by measurement, not assumption: scaling this way flattens the miss rate to **16.7% /
17.4% / 18.1%** across one, two and three sessions. The stop distance and the position
size are deliberately unchanged — staleness is a fill-certainty problem, not a risk one —
and a live-priced name drops back to 1, so this is a no-op the moment the real fix lands.

**Scope, stated honestly: on the main path this is already a no-op.** The live overlay
covers estimate-carrying names, so their staleness is 1 and the buffer is unchanged. The
widening binds on the convergence sweep, on names the feed misses, and on closed-market or
failed-quote runs. It is a floor under the failure modes, not the main fix — the main fix
was already in place and I mis-read the log into thinking otherwise.

**The convergence sweep now prices off the tape too (2026-07-31).** It was the ONE
order-submitting path still anchored to a stored close while every other name in the run
priced live — and it is the path whose whole job is repairing divergence, so it was
retrying exactly the names nothing else had refreshed. It now runs the same overlay under
the same rules: only while the market is genuinely open, per-stock fallback so a partial
response degrades name-by-name, and only for names that already have a stored price, so a
quote alone can never conjure an entry the sweep would otherwise have skipped.

**And the run log can now tell the difference.** `pricing` carries `sweepLivePriced` /
`sweepTotalPriced` separately from the main path, because one aggregate would hide the
failure that matters: a run at 100% live on the main path and 0% on the sweep is not a
live-priced run. `auditRunProvenance` emits `SWEEP_PRICED_STALE` (warn) for exactly that
shape, and stays silent when the sweep had no names, when the market was closed, and on
logs written before the fields existed — an alarm that fires on old logs is one nobody
reads.

**Still unmeasured:** whether any of the execution work helped. Only **11 live BUY orders**
exist since the 2026-07-27 fixes (the book was frozen most of July), and fill rate sat at
91-93% both before and after — which was never the right metric anyway, since the audit's
point was *which* orders miss, not how many. The honest position is that the bias is now
bounded by construction; there is not yet data to show the outcome moved.

**Method note.** `priceSource` existing on only ONE run is why a wrong query looked like a
finding. A field that is absent for 13 of 14 days cannot distinguish "feature off" from
"logging added yesterday" — which is the same absence-reads-as-a-default failure this
register was created to stop, committed by its own author against his own instrument.

**Caveats on record:** ~40 tests across the investigation, so ~2 cells at |t|>2 are
expected by chance — the out-of-sample split is what separates signal from that, and it
is why the RSI hypothesis was dropped. **Survivorship bias**: the 104 names are today's
watchlist tested back to 2021, which inflates momentum-family results specifically.
Close-to-close IC with no fills and no costs; costs make this worse, not better.

---

## Exit-ladder attribution, 2026-08-24 — the trail ratchet is the rung that cuts winners short

The strategy thread's "cannot be attributed to a specific exit rung until `exitReason`
accumulates" matured: **62 labelled `_RM` closes** (24 COMBINED_RM, 24 QUANT_RM,
14 SENTIMENT_RM; 57 unique ticker × exit-day pairs, so pooled n overstates
independence). Reproducible via `npx tsx scripts/exit-ladder-study.ts` (read-only):
per-rung outcomes, MFE capture off the persisted `peakPrice`, post-exit drift vs SPY
with t-stats across exit *sessions* (never pooled — same lesson as `entryTStat`), and
the ratchet counterfactual. SPY left the tracked universe 2026-07-29, so the study's
benchmark comes from `getDailyPrices("SPY")` — the app's own source chain — not
`PriceBar`.

| rung | n | mean ret | total $ | mean MFE | giveback | med capture | 5d drift vs SPY (t, sess) |
|---|---|---|---|---|---|---|---|
| STOP | 10 | -8.90% | -660 | 1.3% | -10.1% | — | +2.86% (2.40, 4) |
| TRAIL | 9 | +9.65% | +589 | **20.4%** | -8.9% | **0.43** | +3.81% (1.02, 3) |
| SIGNAL | 4 | +7.65% | +199 | 12.8% | -4.7% | 0.36 | n too small |
| DECAY | 24 | +6.40% | +1,087 | 6.7% | **-0.3%** | **0.77** | +1.21% (2.15, 5) |
| TIME | 15 | +1.39% | +154 | 6.3% | -4.4% | 0.23 | +3.82% (0.29, 6) |

Reading, rung by rung:

- **DECAY is the best rung in the system** — 24 exits, 77% median capture of the peak,
  essentially zero giveback, and $1,087 of the sample's $1,369 total P&L. "Thesis
  played out, take the profit" is doing exactly what it was designed to do.
- **TIME works as designed** — 15 dead-money exits for ~breakeven ($154), freeing
  slots. Its low capture (0.23) is definitional: it only fires on names that round-tripped
  back to flat.
- **STOP** is the entire loss side (all 10 losses, ≈ -8.9% each — beyond the 6-8%
  designed distance because closes gap through the stop, which is the honest fill).
  Stopped names then *beat* SPY over the next 5 sessions (+2.86%, t 2.40 across 4
  sessions — suggestive, tiny n): stops tend to sell local lows, and
  `brokerReentryRuns: 10` then locks the book out of the recovery for two weeks. Watch,
  don't widen — capital protection is the rung's job.
- **TRAIL is where winners are cut short.** Mean peak +20.4%, mean banked +9.65% —
  median capture 0.43 — and **8 of the 9 exits had the ratchet active** (peak ≥ +15%,
  trail halved). The names it sold kept running: 10-day post-exit drift +14.85%
  (t 2.10, but only 3 sessions / 3 unique names).

**Ratchet counterfactual** (from each exit's *recorded* state — entry and peak are
ground truth on the closed row — walking only post-exit bars under the full-width
trail; replaying whole trades from entry is not possible because the book's price
stream lags the bar sessions and runs can skip names):

| name | actual | full-width trail | delta |
|---|---|---|---|
| PLTR (×2 books) | +6.7% @07-23 | still open, +47.9% @08-17 | +41.1pp |
| TOST (×2 books) | +15.9% @07-24 | still open, +40.0% @08-17 | +24.2pp |
| DDOG | +11.4% @07-23 | still open, +19.8% @07-29 (bars end) | +8.4pp |
| SLB | +2.0% @07-30 | wide trail fires same day | 0 |
| AAPL / KLAC / RKLB | — | no post-exit bars — excluded | — |

Mean +23.2pp over 6 trades (4 unique names). "Still open" deltas are marks at the
name's last stored bar, not realised exits — but the wide trail bounds any later exit
at `peak × (1 - trail)`, so the direction is not an artifact of truncation.

**The cut-winners-short signature did NOT reproduce at the aggregate level in this
window** — labelled sample: 75.8% win, payoff 1.00, +3.27%/trade vs the historical
55-62% / 0.54-0.66. Two reasons to distrust the improvement: composition (DECAY and
TRAIL can only fire in profit, and they dominate the labelled mix) and regime (the
label window 07-21 → 08-21 was a rally; the pre-label sample carried the June-July
chop). What survives composition and regime is the *structural* finding: the one
mechanism measurably truncating winners is the ratchet — the feature added so big
winners "give back less" is what sells the book's best names into routine pullbacks.

**What this settles / does not.** One five-week rally window; every drift t is on 2-6
sessions; the counterfactual is 4 unique names. Nothing here ships a knob change by
itself. It nominates exactly one pre-registered candidate: **`trailRatchetFrac` 0.5 →
1.0 (disable the ratchet), or equivalently a much higher `trailRatchetActivatePct`**,
to be evaluated the way this codebase evaluates things — as a measurable change with
the pure `COMBINED` book untouched as baseline, judged after it accumulates its own
labelled exits. The DECAY/TIME/STOP rungs earn no change candidate at all, and
"leave the exits alone" stands for them.

### ACTED ON 2026-08-24: the ratchet is disabled

The pre-registered candidate above shipped as the first `tradingConfig` DB override:
`{ "trailRatchetFrac": 1 }` — the ratchet branch still executes but multiplies the
trail by 1, so a big winner keeps the full-width trail. Chosen over
`trailRatchetActivatePct: 0` because it is the exact counterfactual the study
measured. Takes effect on the next stage run (the knob is read from the DB each
run; no deploy involved) and reaches both places the ratchet lives: the sim ladder
(`reconcileRiskManaged`) and the live book's broker trailing stop
(`planBrokerAction` — the tighten-resting-trail repair also goes inert, since the
recomputed width now equals the resting one). The pure books have no ladder and are
untouched, as is every other rung.

**Evaluation, written down before the data arrives:** judge on TRAIL exits from
positions whose trail *armed* after 2026-08-24, against the pre-change TRAIL
sample (capture ratio, giveback, post-exit drift) and the untouched `COMBINED`
baseline. TRAIL exits arrive ~2/week, so the earliest honest read is ~6 weeks out
(**revisit ≈ 2026-10-05**). The expected cost is known and accepted: without the
ratchet a big winner can give back the full trail distance from its peak — the
study says that trade-off paid +23pp on the measured sample, and if the live books
disagree the knob reverses it (delete the row or set 0.5). The register asserts
the row's exact content — see the Strategy-thread bullet — so a drift in either
direction surfaces as `REGISTER_STALE`.

**Found while measuring — investigated 2026-08-24, and the first read was wrong.**
This paragraph originally said "the pipeline has been starving since 2026-08-18: only
4 of ~70 names have rows past session 2026-08-17, most positions unmanaged." That was
`max(sessionDate)` silently skipping NULLs — absence read as a default, the exact
failure mode in the method note above, committed again. The pipeline runs at full
volume and estimates flow daily; positions are managed. The real defect is narrower
and older — see "The Tiingo date defect" below.

---

## The Tiingo date defect, 2026-08-24 — `sessionDate` and the PriceBar append have been broken for US names since the day they shipped

**Root cause, confirmed in the production run logs.** Tiingo serves US equities in
prod (the key has been set since ~June; Yahoo is only the fallback), and
`tiingo-prices.ts` passes Tiingo's raw `date` — a full ISO datetime,
`2026-08-22T00:00:00.000Z` — straight through. `barDate()` (`price-bars.ts`) builds
`new Date(\`${date}T00:00:00.000Z\`)`, which on an already-suffixed string yields
`Invalid Date`. Two consequences from the one line, every day, for every
Tiingo-served name:

1. every bar in the window is rejected `INVALID_DATE` → **zero `PriceBar` rows**;
2. `sessionDate = barDate(lastPrice.date)` → **null**.

The quant stage's own errors have named it daily — the GH workflow log prints
`"Price bars rejected for AAPL (Tiingo): INVALID_DATE=41"` for every US name in
every run — but stage errors keep the run green and nothing alerts on them.

**Since when: the features' first live day.** `sessionDate` recording (9601cf7) and
the in-stage PriceBar append (01c0976) both shipped 2026-07-30; the first scheduled
run after the deploy was 07-31, and the populated/null split flipped 105/5 → 4/106
overnight. Populated `sessionDate` before 07-31 is the feature's own backfill.
Since then, US-name data heals only on days Tiingo happens to fail and Yahoo (whose
adapter formats dates correctly) serves instead: 08-10 partially (21 names), 08-18
fully (70 names, 737 bars backfilled in one run via `skipDuplicates`). The 4
always-healthy names are the dot-suffixed European listings Tiingo's plan can't
serve. The *prices* are fine throughout — `QuantAnalysis.price` moves daily —
only the date string handling is broken.

**Blast radius:**

- **`PriceBar`**: no US bars written on Tiingo days since 07-30; sessions
  2026-08-18 → 08-22 are currently missing for ~66 US names (until the next
  Yahoo-fallback day or a backfill run heals them). This is what truncated the
  exit-ladder study's drift windows.
- **`sessionsStale()`** treats null as maximally stale (5), so
  `stalenessScaledBuffer` has been widening the entry buffer 2% → ~4.5% on every
  path the live-quote overlay doesn't cover (the convergence sweep, closed-market
  runs, feed misses) since 07-31 — the "no-op the moment the real fix lands"
  fallback has in fact been the *only* regime on those paths.
- **`signal-health.ts`** keys its sessions off `sessionDate`, so null rows drop out:
  the August "live entry excess" readings quoted in the quant section (08-17, 08-22)
  were computed on a sample that mostly ends 07-30 plus the two Yahoo-fallback days.
  Those readings are weaker than they already looked.
- **`explain-day`** and any sessionDate-joined audit degrade the same way.
- Separate but adjacent: **Binance returns 451** (geo-block) from GH runners, so
  BTC-USD rides Tiingo and hits the same date defect.

**FIXED 2026-08-24, same day.** Four parts, in dependency order:

1. **Adapter** — `tiingo-prices.ts` now normalizes both paths to the plain session
   date (`d.date.split("T")[0]`), with a regression test
   (`tiingo-prices.test.ts`) that runs the result through `barDate()`. `barDate`
   itself stays strict: the INVALID_DATE counter is the tripwire for the next
   adapter that drifts.
2. **Monitoring** — `auditBarFreshness` (`daily-review.ts`, pure, tested) fires
   `PRICE_BARS_STALE` when ≥20% of the universe lacks a bar within 3 sessions.
   Deliberately watches the DATA, not the error strings, because the stage writes
   a full day of QuantAnalysis rows while rejecting every bar — row counts can't
   see this failure mode, only the bars can.
3. **PriceBar backfill** — `backfill-price-bars.ts --from=2026-08-01 --source=Yahoo`
   inserted 851 bars; every universe name's bars now run through 2026-08-21.
   Yahoo deliberately, to keep the corpus on one adjustment basis — post-deploy
   appends will come from Tiingo, and `source` records the seam.
4. **sessionDate repair** — `repair-session-dates.ts`, the original migration's
   two-tier close-match consensus restricted to the nulled rows (write day ≥
   07-31) with an explicit US-calendar guard. All 25 run days resolved
   unanimously (37–105 votes each); 2,542 rows repaired, 25 left NULL (BTC-USD —
   different calendar, by design).

**Still true until the fix deploys:** prod's scheduled runs keep writing null
`sessionDate` and no bars (the repair scripts are re-runnable to catch up). The
August signal-health caveat above also stands for any analysis already recorded —
the underlying rows are repaired now, but conclusions drawn from the thin sample
before the repair were drawn from the thin sample.

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

## Post-repair measurement notes, 2026-08-24

Three read-only studies run the same day as the sessionDate repair, on the healed
data. Reproducible: `scripts/signal-health-rerun.ts`, `scripts/earnings-study.ts`.

### 1. Signal health re-read on the repaired 90-day window

The August live readings quoted in the quant section above were computed while
most rows since 07-31 had NULL `sessionDate` and silently dropped out of the
join. On the repaired window (52 scored sessions, 6,235 observations with a full
5-session forward window):

| source | entry excess | t (NW, across sessions) | note |
|---|---|---|---|
| COMBINED | **-53.5 bps** | **-2.42** (52 sess) | crosses the SIGNAL_INVERTED line; NEUTRAL bucket +50.0 bps (t 4.25) |
| SENTIMENT | -15.1 bps | -0.37 | but **STRONG_BUY -80.9 bps (t -3.56, n=1017)** vs BUY +8.6 — conviction is non-monotonic |
| QUANT | -58.9 bps | -0.77 (44 sess) | noise; consistent with "do not read its sign" |

QUANT's SELL bucket sits at +182 bps (t 6.22) — the same inversion shape the
holdout study found. The 08-22 note above recorded COMBINED at t = -0.85 and
called the alert a false positive; that number was itself computed on the
sessionDate-holed sample, so the honest live reading was never actually taken
until now. **Still one 90-day rally window — a prompt to investigate, not to
act** — and the next daily review will raise SIGNAL_INVERTED on COMBINED by
itself. The most specific new lead is SENTIMENT's STRONG_BUY bucket: since
07-31 the `_RM` entry gate reads the sentiment score, so "highest-conviction
sentiment underperforms its own BUY bucket" is now an entry-path question, not
a diagnostic curiosity.

### 2. Earnings study — no blackout ships

`daysToEarnings` has been recorded since June but only dampens confidence at
estimate time; before proposing a blackout or pre-earnings exit, the closed
trades were measured (1,277 unique (ticker, entry, exit) events with earnings
coverage, since 2026-06-01):

| group | n | win | mean | mean loss |
|---|---|---|---|---|
| held through an earnings date | 201 | 58% | **+1.15%** | -4.68% |
| no earnings in hold | 1,076 | 46% | -0.20% | -3.55% |
| entered ≤3d before earnings | 108 | 47% | -0.69% | -4.11% |

Holding through earnings was *profitable* in this window, so a pre-earnings
exit is contraindicated. The tail does hold a specific pattern — RDDT, APP and
DDOG were entered 0-1 days before a scheduled print and lost 17-21% on the gap
(all then exited by the SIGNAL rung doing its job) — and the ≤3d entry bucket
nets weakly negative, so a narrow (~2-3 day) **entry** blackout has weak
in-sample support. Parked, not shipped: the mean effect is small, the ≤5d
bucket flips positive (+0.22%, n=167), and one summer of rally tape cannot
price the variance. Recorded so the idea is not re-proposed from scratch.

### 3. STRONG_BUY dissection — real shape, episodic, no action

Follow-up on #1's lead (`scripts/strong-buy-study.ts`). The excess-by-score
gradient is monotone-inverted above ~0.4: +24 / +20 / -4 / **-90 / -57 / -105**
bps across the six bins from non-entry to (0.8, 1.0]. It is broad, not a
few-names artifact — 1,017 STRONG_BUY observations over 106 names, top-5 share
11% (though ARM at -883 bps and AMAT at -702 show where the hype names live).
The paired same-session STRONG_BUY-minus-BUY difference is -81.9 bps (t -1.69,
52 sessions) — suggestive, short of significant.

**The disqualifier is the month split: July -173 bps (t -3.43), August +2 bps
(t -0.30).** The effect was one episode — July's chop punishing high-sentiment
names — and is not currently active. Touching the entry gate off one adverse
month of one summer would be fitting an episode, and unlike the quant score
there is no multi-year corpus to holdout-test sentiment against: the scores
only exist since June. Verdict: **measured, recorded, no action.** The durable
observation worth keeping is that the top of the sentiment scale has carried no
positive information in its whole recorded life — if that is still true after
another quarter of sessions, a score cap (treating >0.6 as 0.6 at entry)
becomes a testable candidate with an actual sample behind it.

### 4. CRWD's 4:1 split corrupts four closed positions (and every aggregate over them)

Surfaced by the earnings study's worst-trades list: two "-71/-72%" CRWD events.
Entry was recorded at the raw pre-split price (678.65 = 4 × the adjusted 169.66
close of 2026-06-25) and the exit at the post-split price (193.98), across
SENTIMENT, COMBINED, SENTIMENT_RM and COMBINED_RM — **~$1,757 of fictitious
realized loss on holds where CRWD actually gained ~14% adjusted**. Every
closed-trade aggregate in this register carries it: pure COMBINED's "-$2,494
over 439 closes" is about one-sixth this single artifact, and the loss side of
the "payoff 0.54-0.66" figure is inflated by it.

**Status 2026-08-24:** a full-book scan found exactly the four known rows and no
open positions affected. The guard shipped — `auditCorporateActions`
(`daily-review.ts`, pure, tested) watches each OPEN position's price stream for
one-step moves outside 0.6-1.67x and warns `CORPORATE_ACTION_SUSPECT`, so the
next basis break surfaces while the position is still open and repairable. The
repair itself is `scripts/repair-crwd-split.ts` (qty ×4, entryPrice ÷4,
peakPrice ÷4, realizedPnl recomputed — dry-run verified: +$86/+$69 instead of
-$428/-$470); the write needs to be run by a human, and `PaperEquitySnapshot`
history deliberately keeps the artifact (the daily equity series records what
the books believed at the time).

### 5. Insider cluster-buy event study — the thesis has no support in this universe

First use of the backfilled Form 4 corpus (`scripts/insider-event-study.ts`,
2026-08-24 evening). Reconstructs the exact live event — ≥3 distinct open-market
buyers inside a filed-by-then 14-day window, 56-day cooldown, executable
next-open entry — and measures abnormal returns vs an equal-weight index of the
bar corpus:

- **The signal barely exists here: 15 events in five years.** 998 open-market
  buys against 42,089 sells — insiders at watchlist-scale companies almost never
  cluster-buy. The event book's trigger fires ~3 times a year.
- **Where it fires, the drift is negative, not positive**: h=40 mean AR -6.2%
  (43% hit), h=60 -10.8% (36% hit), t(events) -1.9 — underpowered, but pointing
  the wrong way for a long thesis.
- **The tails explain the sample**: the worst events are RIVN 2021-11 and TOST
  2021-09 (IPO-window "open-market buys" followed by post-IPO collapse) and SCHW
  2023-03 (buying the regional-bank-crisis knife). The placebo (same names,
  -180d) is also negative (-7.7% at h=60, t -2.05, n=9), so the measured "drift"
  is substantially the era-drift of these names rather than the event — the
  placebo doing exactly its job at n=15.
- **Sell clusters (n=855, the honest-sized sample) show ~nothing** at 20-60
  sessions — consistent with the literature that insider sales are
  uninformative, and evidence the instrument reads flat when there is nothing.

**Verdict: the research-backed 20-60-day cluster-buy drift is a small-cap
phenomenon, and this watchlist is exactly where it should not and does not
appear.** The insider event book stays ship-dark, and no effort should go into
arming it on this signal in this universe. What remains untested is the C-suite
variant (Finnhub carries no roles; EDGAR does) and any future small/mid-cap
universe expansion — the corpus is ready if either happens.

---

## Slot-constrained selection, 2026-08-31 — replacement does not beat the incumbent on this score

The live book holds 12 names and vetoes 46–59 candidates a session on `MAX_POSITIONS`.
Once it is full, a holding is only ever released by the exit ladder — never because a
better name is available. Does reconsidering holdings against the ranking beat that?

**New instrument.** `src/lib/portfolio-sim.ts` (pure) + `scripts/policy-compare.ts`
(`npm run policy-compare -- --frame=fill`). The score harness cannot answer this:
cross-sectional IC is invariant to selection policy, so threshold-and-hold and
rank-with-replacement consume the identical ranking and produce the identical number.
The sim's unit of observation is a portfolio-session, and the headline is the paired
per-session difference against the incumbent (Newey-West, lag 5), split and folded the
same way `signal-research` splits features.

**Result** — `baseline` candidate (`calcQuantScore` as shipped), 121,179 rows over
~1,190 sessions, split 2025-01-01, 4 folds:

| policy | train | holdout | folds+ | turnover | verdict |
|---|---|---|---|---|---|
| `PA-arrival` (pre-`a3a720c`) | -0.8 bps (t -0.42) | +1.2 (t +0.45) | 3/4 | 0.81/sess | FAILS |
| `P1-replace` | **-1.7 bps (t -1.00)** | **-1.0 (t -0.34)** | 1/4 | 1.02/sess | FAILS |
| `P3-replace-slow` | +0.1 (t +0.05) | -1.4 (t -0.54) | 2/4 | 1.01/sess | FAILS |
| `P2-topN` (ceiling) | +0.6 (t +0.20) | -1.7 (t -0.31) | 3/4 | 3.60/sess | FAILS |

Fill frame. Control passes: the oracle scores **+301.4 bps/session** under `P2-topN`
against the incumbent score's -0.0, so the simulator can detect a policy improvement
that exists. Every policy also FAILS on `exec` and on `close`.

**These are the numbers on the REPAIRED corpus.** The first run used the feature cache
built 2026-08-24 18:36, which predates that day's Yahoo backfill and is missing the bars
the Tiingo defect had been rejecting — AMAT, for one, had no 07-30 or 07-31 row. Inserting
a missing session shifts the `i + h` index, so 1,017 rows carried wrong long-horizon
forward returns and 589 rows were absent entirely. Conclusions did not move (the largest
shift was `P2-topN`'s holdout, -2.1 → -1.7 bps), but **anything else read off that cache
between 2026-08-24 and 2026-08-31 was computed on a corpus known to be wrong.** The cache
is gitignored and rebuildable: `npm run signal-research -- --rebuild-cache`, or
`npx tsx scripts/fetch-corpus.ts` for the credential-free path.

**The `close` frame is the informative one.** There, turnover is free — the entry is
priced at a close nothing can trade at — and replacement STILL loses (`P1` -1.6 train /
-1.2 holdout). So this is not a story about swapping being expensive. Ranking harder on
this score simply does not find better names, which is exactly what the quant section
above already establishes: `calcQuantScore`'s holdout ranking IC is -0.0232 (t = -2.25).
**A selection policy is a multiplier on signal quality, and this one is being applied to
a signal with the wrong sign.**

Measured incidentally: `PA-arrival` — the book as it stood before ranked entry
allocation shipped — is indistinguishable from the ranked allocation that replaced it
(|t| < 0.6 in both periods, and the sign flips between them). `a3a720c` was the right
change on principle and bought nothing measurable, for the same reason.

**What this does not say.** Nothing here tests replacement on a score that ranks. Re-run
`npm run policy-compare -- --candidate=<id>` against any candidate that clears the score
harness first — the instrument is score-agnostic and the run takes seconds off the
cached features. Three modelling gaps all bias TOWARD the hypothesis (survivorship from
projecting today's universe back to 2021, no price stops in the simulated ladder, no
exit slippage) and it failed anyway, so the null is if anything understated.

`k` is now kept in `research-ledger.json`, not in a constant: 12 policy specifications
(four policies x three frames, all actually run) -> |t| floor 2.23. Every policy tried
against this corpus counts toward it, including one tried and abandoned. Add to it, not
around it.


## Entry bands, 2026-08-31 — the top bucket is genuinely bad, and dropping it only reaches the universe

`npm run signal-split -- --bands --source=SENTIMENT`. Which slice of the score should
open a position at all? SENTIMENT because that is what COMBINED_RM enters on
(`combinedEntryUsesQuant: 0`, and the live `tradingConfig` overrides only
`trailRatchetFrac`). The other two sources were deliberately NOT run: 6 more band specs
would raise the noise floor for everything without being able to change the decision.

**First, a correction to how the buckets were being read.** `signalHealth`'s per-bucket
`tStat` is `tStatOneSample` **pooled across observations**, which the module's own comment
marks as descriptive and overstated — a hundred names on one good session count as a
hundred pieces of evidence when they are one. Sentiment's STRONG_BUY bucket reads
**t = -3.74** that way and **t = -1.37** computed across sessions with Newey-West, which is
the statistic the entry number has always used. Roughly 2.7x inflation. Nothing had ever
gated on the bucket t, but it was being quoted as though it were a test.

**Result** (58 entry sessions, split at the median session, 4 rolling folds, k=3):

| band | ALL | TRAIN | HOLDOUT | folds+ | verdict |
|---|---|---|---|---|---|
| `band-current` (incumbent: BUY+STRONG_BUY) | -14.6 (t -0.54) | -7.6 (t +0.33) | **-19.3 (t -2.23)** | 1/4 | — |
| `band-no-strong` (BUY only) | +8.6 (t +0.93) | +19.6 (t +0.96) | **+0.2 (t +0.44)** | 3/4 | MATCHES |
| `band-strong-only` (control) | -79.5 (t -1.37) | -114.8 (t -0.54) | -63.8 (t -1.64) | 0/4 | LAGS |
| `band-neutral-up` (NEUTRAL+BUY) | +16.7 (t +1.31) | +23.7 (t +0.65) | +11.8 (t +1.18) | 4/4 | MATCHES |

Three things it establishes:

1. **The STRONG_BUY effect replicates.** `band-strong-only` is negative in the full
   window, in train, in holdout, and in 0 of 4 folds. That is the control doing its job:
   the bad bucket is bad everywhere, not in one period.
2. **Dropping it reaches the universe and stops there.** Holdout goes from **-19.3 bps to
   +0.2 bps** — statistically indistinguishable from simply holding the 104 names. It ends
   the bleeding; it is not an edge. And a 12-name book that merely matches the universe is
   worse than holding the universe: same return, far more variance.
3. **Nothing BEATS the universe.** `band-neutral-up` is the only band positive in every
   period with 4 of 4 folds agreeing, and its holdout t is 1.18 against a floor of 2.00.
   It is the best lead on the table and it is not a result.

The incumbent's own holdout number is the sharpest argument for changing something:
**-19.3 bps at t = -2.23**, i.e. the band currently traded is significantly *worse* than
the universe out of sample.

**Sample caveat, and it is the binding one.** 58 entry sessions, ~29 per half. The
sentiment scores only exist from 2026-06-01, and the 120k stock-day research corpus is
`PriceBar`-only, so **this cannot be tested on the big corpus** — no amount of care makes
29 sessions decisive. Read the consistent SIGN across ALL/train/holdout/folds, which is
what `band-strong-only` and `band-neutral-up` both have, and not any single t.

Bands are recorded in `research-ledger.json` under the `band` kind, so `k` rises for
every band tried, per family. Code: `src/lib/signal-band.ts` (pure, tested) +
`--bands` in `scripts/signal-split.ts`.


**SHIPPED 2026-08-31 anyway, and the reasoning matters.** `band-no-strong` verdicts
MATCHES, and the tool's own rule says MATCHES is not a pass — so shipping it is a
deliberate departure from that rule, on this argument: the bar for *removing* a component
measured to lose is not the bar for *adding* one claimed to win. The incumbent band is
-19.3 bps at t = -2.23 out of sample; `band-strong-only` is negative in every period and
0 of 4 folds. Staying put is a measured loss, and the change removes it rather than
betting on a new effect. It reaches the universe and no further, which is the honest
description of what was bought.

`entryScoreMax` (`RiskConfig`, default **0.6**, `PAPER_ENTRY_SCORE_MAX`, and a
`TRADING_KNOBS` entry so it is revertible without a deploy). Shipped as a CODE DEFAULT,
not a `tradingConfig` override, so the `knobs-single-ratchet-override` assertion above
stays true. **Entry only** — a held position whose score climbs past the cap is not
exited, the same entry/exit split `combinedEntryUsesQuant` uses, and for the same reason:
the evidence is about what buying at the top does, not about holding through it.

<!-- check: entry-band-in-force -->
- **No `_RM` entry has opened above the cap since it shipped.** Checked against what the
  book actually did rather than the config it was supposed to read, because a reverted
  knob and a working one look identical from the code.

**What this does NOT change:** `signalHealth` still reports the BUY+STRONG_BUY band, and
should — it monitors the SIGNAL, not the book, and "is this source healthy" is a question
about the whole bullish range. Expect the review's SENTIMENT entry figure to keep
describing a wider band than the book now trades; that is the monitor working, not drift.


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
<!-- check: unmanaged-positions-latent -->
- **Missing-fresh-estimate positions go unmanaged.** The paper stage loads only
  estimates dated today and only open positions for those stock ids, so a name without
  a fresh estimate is neither marked nor exited. Verified **zero occurrences in prod**
  (all 151 open positions marked 2026-07-24), so this is latent, not active — but
  unguarded.
<!-- check: article-count-capped -->
- **`articleCount` counts the LLM prompt, not the news** (traced 2026-07-31, deferred
  by decision). `sentiment.ts:42-59` fetches the 20 most recent articles in a 7-day
  window, dedupes by normalised headline, **`.slice(0, 10)`** to bound the prompt — and
  only *then* sets `articleCount = uniqueArticles.length`. The slice is a legitimate
  cost control; measuring after it is the defect. Over the window the median stock has
  **45.5** articles (mean 93, max 1,076) and **91% exceed 10**, so for nine names in ten
  the field is the constant 10. Three consequences:

  1. `sentWeight = min(0.3 + articleCount/15 × 0.3, 0.6)` (`estimate.ts:139`) is built
     to reach 0.6 at 15 articles. It **cannot exceed 0.5**, and 88% of rows sit there —
     the top third of the designed range is dead code and the "dynamic" blend is nearly
     a constant.
  2. The `articleCount >= 10 → confidence +0.15` bump fires when the **slice hit its
     cap**, not when a name is newsworthy. 1,076 articles and exactly 10 are
     indistinguishable.
  3. `articleVelocityRatio = last24hCount / (articleCount / 7)` divides an **uncapped**
     count by a **capped** one, so for 91% of names the denominator is a fixed 1.43/day.
     Observed median **3.50**, max 196, and **3,177 of 4,787 rows read above 2×** — two
     thirds of all estimates permanently look like a news spike. Currently persisted but
     **not consumed anywhere**, so it is a corrupted field awaiting its first reader
     rather than something distorting trades today.

  **The fix is to count before the slice** — two lines. Deferred deliberately: it moves
  `sentWeight` for essentially every name, which shifts `combinedScore`, which since
  2026-07-31 drives `COMBINED_RM`'s **exits**. Entry weighting changed the same day, and
  the exits are the one component measured to be working (-2.97% post-exit drift excess
  over SPY). Changing both in one week makes neither measurable. Revisit once the entry
  change has a few weeks of closes behind it.

---

## Strategy thread (predates the execution review)

<!-- check: knobs-single-ratchet-override -->
- **One deliberate DB override; every other knob at its code default.** The
  `tradingConfig` row holds exactly `{ "trailRatchetFrac": 1 }` — the 2026-08-24
  ratchet disable (see "ACTED ON 2026-08-24" under the exit-ladder attribution).
  Until that date there was no row at all; the old `exit-labels-too-few` revisit
  trigger fired at 62 labelled exits, produced the attribution study it existed to
  prompt, and both retired here. The assertion now checks the row's *content*, so a
  second knob drifting in — or the override silently vanishing — is what trips it.
- **Entry score buckets: RESOLVED 2026-07-31, and they do not slope the right way.** The
  sample passed its threshold (178 closes, was 59), so the claim was re-run instead of
  requoted. Quintiles of `entryScore` against trade return:

  | quintile | score range | n | mean return | win |
  |---|---|---|---|---|
  | 1 (lowest) | 0.203–0.240 | 36 | **-0.90%** | 38.9% |
  | 2 | 0.240–0.286 | 36 | -1.06% | 44.4% |
  | 3 | 0.291–0.360 | 36 | -0.98% | 38.9% |
  | 4 | 0.360–0.465 | 35 | **-1.59%** | 34.3% |
  | 5 (highest) | 0.480–0.860 | 35 | -1.44% | 40.0% |

  Not monotonic, and mildly **inverted** — the best-scoring quintile underperforms the
  worst by 0.5pp. Spearman **-0.0917** (n=178, t ≈ -1.22). Underpowered and pooled across
  overlapping books (COMBINED 89, SENTIMENT 77, QUANT 10, QUANT_RM 2 — the same names on
  the same days), so the effective N is well below 178 and -1.22 is an upper bound on the
  evidence. **Do not tune an entry threshold on this.** It is recorded because it is the
  third independent line pointing the same way as the holdout study and the fill audit,
  not because it is significant on its own.
- **The real signal is payoff, not hit rate.** Across 176 `_RM` trades: hit rate
  55–62% (good), payoff 0.54–0.66, losses ~1.6× winners. Classic cut-winners-short
  signature, consistent across three independent books. **Attributed 2026-08-24** —
  see "Exit-ladder attribution" above: the truncation mechanism is the trail ratchet;
  DECAY/TIME/STOP earn no change.
<!-- check: entry-freeze-drained -->
- **The 15-session entry freeze — drained, now watched.** `SENTIMENT_RM` and
  `COMBINED_RM` took zero entries 2026-07-01 → 07-24; 100% of intended entries vetoed.
  Cause: `maxPositions: 12` evaluated against the *run-start* position count, with books
  seeded at 83/94 names before the limits were switched on. It resolved as predicted —
  34 `_RM` entries in the 30 days to 2026-07-30. The assertion is kept but **inverted**:
  it now fires if the books stop taking entries again, because a book that only ever
  shrinks looks healthy from every other angle.

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
