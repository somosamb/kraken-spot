# Changelog

## 1.1.1 — 2026-10-31

Documentation only.

- README rewritten around a quick start, a cycle diagram and an honest **Results** section.
  It now includes a backtest of the live configuration: 0/4 PASS, 0/4 BUST, 22 entries
  in 2 years.
- New [docs/OPERATIONS.md](docs/OPERATIONS.md) runbook:
  - start, stop and cron
  - control files
  - logs and the ledger schema
  - troubleshooting by log message
  - challenge reset
- Corrected claims that didn't match the code:
  - The cycle interval is ~1 min, not 45 s.
  - After 8 failures the runner exits and the watchdog restarts it; it does not stay
    stopped.
  - The win-rate freeze needs *more than* 15 trades.
  - `sweep_spot.mjs` is a legacy sweep that cannot test the live configuration.
    `backtest.mjs` with environment variables is the supported path.

## 1.1.0 — 2026-10-31

Reliability release. Every fix below corresponds to a failure seen in the live paper run.

### Fixed
- **Untracked positions and duplicate buys.**
  - Before: state was only saved at the end of a cycle. A cycle killed by the timeout
    after a buy lost the position, and the next cycle bought again (TRX and XLM were each
    bought twice).
  - Now: state is saved atomically right after every buy, sell and TP placement.
  - Now: every cycle reconciles `state.json` against the real balances (adopt / book /
    resize).
  - Now: entries skip pairs that are already held.
- **False BUST liquidations.**
  - Before: the venue intermittently reported a cash-only equity ($724.58), which
    triggered "GAME OVER" and flattened real positions.
  - Now: equity is cross-checked against our own mark-to-market valuation, and the venue
    figure is rejected on disagreement or when it reports `valuation_complete: false`.
  - Now: PASS/BUST must be confirmed by a second read.
- **Watchdog revived the bot after a BUST.** Before, the runner stopped and the watchdog
  restarted it 45 s later. Now a confirmed terminal verdict writes `HALTED`, which the
  runner, watchdog and `kspot` all respect.
- **`FAILURE_SENTINEL` never cleared.** `runner.mjs` called `require()` inside an ES
  module and the error was swallowed.
- **Wrong exit prices in the ledger.** The CLI reports fills at the top level
  (`price`, `fee`, `volume`). Before, the code read `fills[]` and fell back to the ticker.
  Real fees are now booked too.
- **Take-profit fills not detected.** Before, the bot tried to sell coins it no longer
  held and fell back to `cancel-all`. Now reconcile books the TP fill from the trade
  history, and closing only cancels orders on its own symbol.
- **Duplicate watchdogs.** The watchdog is now a single instance via `flock`, the lock is
  not leaked to child processes, and the process-detection patterns match the real
  command lines.
- **Duplicate ledger entries.** Trades are deduplicated by `symbol|openedAt`.

### Changed
- One batched ticker call per cycle instead of one per pair. Cycle time went from ~50 s to
  ~10 s, far from the 600 s timeout.
- Paths and binary are configurable (`KS_DIR`, `KRAKEN_BIN`, `KS_WORKSPACE`). There are no
  more hard-coded home directories.
- `tests.mjs` is fully offline and covers each fix (38 tests). `validate.mjs` checks state
  vs exchange, resting TPs, equity agreement and ledger duplicates.
- Removed dead code: `RISK` constants, `sizeFor`, `rrAfterFees` and `cancelAll`.
- `equity.csv` records which equity source was used instead of a misleading
  "unrealized" column.
- Added `package.json` scripts and moved `PLAN.md` to `docs/`.

## 1.0.0 — 2026-10-30

Initial public version.
