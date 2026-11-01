# Changelog

## Unreleased

### Added
- **Network monitor** (`net.mjs` + `runner.mjs`) for a bot running on a phone with
  unreliable signal.
  - Each cycle combines the previous cycle's CLI latency and network errors, a direct API
    probe, cycle success and the gap since the previous cycle into a state: `OK`,
    `DEGRADED`, `INTERMITTENT` or `OFFLINE`.
  - Hysteresis: 5 good cycles to recover, and 30 clean minutes after flapping.
  - New entries are blocked unless the state is `OK`. Open positions are always managed.
  - State changes are logged, written to `alerts.log` and sent as a detached Termux phone
    notification with a hard kill after 20 s.
- `ctl.kraken()` now uses `spawnSync` so it can see stderr on successful calls. A
  "could not sync … Network error" warning used to pass silently and now counts as a
  network incident.
- New diagnostics:
  - `cyc=` (cycle duration) on every log line
  - `kraken-calls.log` (slow or failed calls)
  - a `net` line on the dashboard
  - a network check in `validate.mjs`
- 23 new tests (82 in total) covering every state transition, the network-error
  classification, and the 2026-11-01 flapping night.

### Fixed (network monitor, first night in the field)
- **Flapping not detected.** Overnight the link went back and forth between `DEGRADED` and
  `OFFLINE` about 20 times without ever reaching `INTERMITTENT`, because only leaving `OK`
  counted as an incident. Now any worsening counts: leaving `OK`, or dropping to `OFFLINE`.
  With the corrected count, the 00:00 TIA entry, which came 27 min after the last cut,
  would have been blocked.
- **`npm stop` killed the in-flight cycle.** `killprocs.sh` now stops the watchdog, waits
  up to 90 s for the running trader cycle to finish, and only then stops the runner.
- The runbook gained a "Deploying code changes safely" section.

- Added the research scripts behind docs/RESEARCH.md under `research/`:
  - `screen.mjs` (event study)
  - `robust.mjs` (signal quality)
  - `risk.mjs` (risk / capacity sweep)
  - `candidates.mjs` (bootstrap)
  - a shared `data.mjs` with the u24 / other / u43 data sets
  They reproduce the documented numbers exactly and pin `LIVE_V1` as their base.
- README: live results updated to 11 trades, none of which measure the strategy.

## 1.2.0 — 2026-10-31

Changes from the screening review. See [docs/RESEARCH.md](docs/RESEARCH.md#screening-evaluation-v12).

### Fixed
- **Signals were one day late.**
  - Before: the candle filter `time < last` also dropped yesterday's completed candle,
    because Kraken's `last` is the open time of the last completed candle.
  - Now: a candle counts as complete once its 24 h are over.
  - Impact: this roughly halved the live edge.
- **Same-day re-entry.** After an exit, the same pair could be bought again on the same
  stale signal. Every close now records `lastExit`, and entries skip that pair until the
  next UTC day.
- **Stale entry price.** The live price must now be within 0.5 ATR of the signal close,
  and position size uses the live price.
- **Correlation inside one cycle.** The guard now also checks positions opened earlier in
  the same cycle.

### Changed (strategy)
- **Volatility floor.** Pairs with ATR below 3% of price are skipped (`lowvol`). In testing
  these traded at −0.13 R, mostly TRX, the source of every worst-case BUST.
- **Correlation window.** The guard uses the last 60 days of returns instead of the full
  history. Full-history correlation had pushed second positions toward TRX.
- **Risk.**

  | Setting | Before | Now |
  |---|---|---|
  | Risk multiplier (`RISK_MULT`) | ×1 | ×3 |
  | Max positions | 2 | 3 |
  | Notional cap per position | 20% | 35% |

  Simulated: 9/48 PASS and 0 BUST with worst-case stop fills, median 445 days to PASS.
  All of that evidence comes from a single bull episode.

### Changed (operations)
- **Freeze sample.** The win-rate freeze now counts only strategy exits (`stop`, `target`,
  `target_fill`, `timestop`) since the v1.2 epoch. Before, the old ledger (1 win in 11,
  mostly bug-forced or manual closes) would have frozen v1.2 after its first few trades.
- The 3 positions inherited from v1.1 (BTC, ARB, NEAR) were closed by hand (−$0.60 net in
  total), because none of them passed the corrected screen.

### Added
- `node trader.mjs close <PAIR…|all>` closes positions by hand through the normal close
  path.
- `screen()` returns a diagnostic with a reject tag for every pair. `bot.log` shows the five
  deepest dips with their tags (`near=[…]`). The tags are documented in
  [OPERATIONS](docs/OPERATIONS.md#reading-near).
- `sweep_live.mjs` gained a `MIN_ATR_PCT` option. Its default configuration is now v1.2;
  `BASE=v1` reproduces v1.1.
- 21 new tests (59 in total), covering screening tags, cooldown, drift, the 60-day
  correlation, the risk multiplier, the candle-completion fix and the freeze sample.

## Research (2026-10-31)

- Added `sweep_live.mjs`, a fast challenge simulator that mirrors the live rules.
  - indicators verified identical to `trader.mjs`
  - rolling starts that run to the end of the data
  - `STOP_FILL` stress modes: `stop`, `mid`, `low`
  - sharded grid search with an in-sample cutoff (`IS_END`)
- Added [docs/RESEARCH.md](docs/RESEARCH.md), a search for a configuration that can reach
  $1120. Conclusion: none does robustly on the available data. The live configuration is
  unchanged.

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
