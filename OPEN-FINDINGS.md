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

<!-- check: quant-signal-inverted -->
**`calcQuantScore` is anti-predictive out of sample.** Established over the whole
`PriceBar` corpus — **119,428 stock-days, 104 names, 2021-10-25 → 2026-07-22** — as daily
cross-sectional IC against 5-day forward returns, t-stat taken across days (pooling would
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
<!-- check: unmanaged-positions-latent -->
- **Missing-fresh-estimate positions go unmanaged.** The paper stage loads only
  estimates dated today and only open positions for those stock ids, so a name without
  a fresh estimate is neither marked nor exited. Verified **zero occurrences in prod**
  (all 151 open positions marked 2026-07-24), so this is latent, not active — but
  unguarded.

---

## Strategy thread (predates the execution review)

<!-- check: knobs-at-defaults --> <!-- check: exit-labels-too-few --> <!-- check: entry-score-too-few -->
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
