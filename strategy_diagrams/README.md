# Strategy diagrams

Decision trees for the paper-trading strategy — how a position gets opened, what has to
allow it, how it gets closed, and what protects it at the broker. Drawn from the code on
2026-07-29, not from a spec.

Open a `.excalidraw` file with any of:

- [excalidraw.com](https://excalidraw.com) → *Open* (or drag the file onto the canvas)
- the **Excalidraw** VS Code extension (opens on click, edits in place)
- the **Excalidraw** Obsidian plugin, if you keep a copy in the vault

| File | What it covers | Code |
|---|---|---|
| `01-opening-a-position.excalidraw` | Eligibility, the per-book entry gate, sizing, ranked slot allocation | `reconcilePosition`, `reconcileRiskManaged`, `rankEntryCandidates` |
| `02-portfolio-buy-gate.excalidraw` | The six book-level checks, worst breach first, plus what scales the gross cap | `evaluateBuy`, `deriskMultiplier`, `regimeMultiplier`, `maxAllowedNotional` |
| `03-closing-a-position.excalidraw` | The `_RM` exit ladder (first match wins), against the pure and event books | `reconcileRiskManaged`, `reconcilePosition`, `reconcileEventPosition` |
| `04-live-broker-book.excalidraw` | Broker entries, which exits stay app-side, protective-order upkeep, order hygiene | `planBrokerAction`, `runPaperStage` |

Sources: `src/lib/paper-trading.ts`, `src/lib/portfolio-risk.ts`, `src/lib/pipeline/paper.ts`.

## Two things to keep in mind when reading them

**The numbers are the code defaults, not necessarily what is running.** Every knob
resolves as env var > `AppSetting.tradingConfig` (the admin page) > code default, so a DB
override changes the tree without a deploy. `src/lib/trading-config.ts` is the registry.

**Most of what is drawn is behind a flag.** `PAPER_RISK_BOOKS`, `PAPER_RISK_LIMITS`,
`PAPER_BROKER_STOPS` and `PAPER_INSIDER_BOOK` each gate their own branch. With all of them
off, only the pure-book paths in diagrams 1 and 3 execute.

These are documentation, not generated artifacts — if the strategy changes, edit the
diagram in Excalidraw and commit it.
