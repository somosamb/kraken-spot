# Kraken Spot Paper — Autonomous Trading Bot

A small, self-hosted bot that trades a **Kraken Spot Paper** workspace through the
`kraken` CLI. It plays a "funded challenge" game:

| Rule | Value |
|---|---|
| Starting balance | $1000 |
| **PASS** | equity ≥ $1120 (+12%) |
| **BUST** | equity ≤ $970 (−3%, static from start) |
| Time / daily limits | none |

> **Paper trading only.** This is an experiment and a learning project, not financial
> advice. It has not demonstrated an edge (see [Results](#results)). Do not point it at
> real money.

## How it works

Every ~45 s the runner executes one **cycle** (`trader.mjs loop`):

1. **Reconcile:** compare `state.json` with the real exchange balances.
   - It adopts holdings that aren't tracked. This happens when a cycle was killed right
     after a buy.
   - It books positions that are gone. This happens when the resting take-profit filled.
   - It fixes tracked sizes that don't match the real holding.
2. **Manage** each open position:
   - software stop at `entry − 1.5 ATR`
   - take-profit at `entry + 0.75 ATR`
   - 10-day time stop
   - optional break-even stop (`FBOT_PROTECT`)
3. **Entry**, which only runs if every filter passes:
   - **Market regime:** BTC is above its EMA200, and the EMA200 is rising.
   - **Pair trend:** the price is above its own EMA200.
   - **Dip:** the price is at least `K = 1.25` ATR below EMA20.
   - **Fees:** the target is at least 1.6%, so it clears the 0.52% round-trip fees.
   - **Correlation:** the pair's correlation with any held position is at most 0.65.
   - **Limits:** at most 2 concurrent positions, and the pair is not already held.
4. **Terminal check:** a PASS or BUST reading has to survive a second independent read.
   Only then does the bot flatten all positions, write a `HALTED` file and stop for good.

Signals use completed **daily** candles, cached on disk with one refresh per UTC day.

### Risk

`riskpolicy.mjs` sets the dollar amount the bot may lose on one trade (stop distance ×
size).

- It is **0 at the floor** and grows linearly to $7 at $1045, then to $20 at the target.
- On top of that a **ratchet** multiplies it by 1.5× from $1015 and by 2× from $1045.
- It is capped at **$75 of open risk** across all positions.
- Each position's notional is also capped at **20% of equity**.

### Safety model

Spot paper has **no native stop orders**, so the runner process *is* the stop.

| Risk | Mitigation |
|---|---|
| Daemon dies | `watchdog.sh` (single instance via `flock`) restarts the runner. `kspot` restarts the watchdog. |
| Cycle hangs | 600 s cycle timeout. After 8 consecutive failures the runner stops for review. |
| Cycle killed mid-trade | State is written atomically right after every buy, sell and TP order. The next cycle reconciles. |
| Bogus equity reading | The venue figure is cross-checked against our own mark-to-market valuation and rejected if they disagree by more than 1% or the venue flags it incomplete. |
| False PASS/BUST | The verdict must be confirmed by a second read 5 s later. |
| Restart after game over | `HALTED` blocks the runner, watchdog and `kspot` until you delete it. |
| Daemon down + price spike | Take-profits rest on the exchange as limit sells. |
| Losing streak | Entries freeze automatically if the win rate drops below 55% after 15 trades. The freeze clears when the win rate recovers. |

## Requirements

- Node.js ≥ 18
- `kraken` CLI on `PATH`, or set `KRAKEN_BIN`
- A funded paper workspace:

  ```sh
  kraken paper init spotbot --capital 1000
  ```

## Usage

```sh
npm test              # offline unit tests (no network, no orders)
npm run validate      # live consistency check: processes, equity, state vs exchange
npm run status        # dashboard
npm run cycle:dry     # one cycle; entries are simulated (reconcile/manage still act)

touch ENTRY_ENABLED   # allow new entries (absent = manage-only "noentry" mode)
npm start             # start watchdog (which starts the runner); idempotent
npm stop              # stop watchdog + runner
```

| File / flag | Meaning |
|---|---|
| `ENTRY_ENABLED` | Present: runner opens new trades. Absent: it only manages existing ones. |
| `HALTED` | Written on a confirmed PASS/BUST. Delete it to resume. |
| `FROZEN` | Written while the win-rate freeze is active (auto-cleared). |
| `FAILURE_SENTINEL` | Last cycle failed. Cleared automatically on the next successful cycle. |

### Configuration

| Env var | Default | |
|---|---|---|
| `KS_DIR` | repo directory | where state, logs and caches live |
| `KRAKEN_BIN` | `kraken` | CLI binary |
| `KS_WORKSPACE` | `spotbot` | paper workspace |
| `FBOT_PROTECT` | `off` | anything else enables the break-even stop |
| `KS_NO_CACHE` | — | `1` disables the OHLC disk cache |

Strategy constants live at the top of `trader.mjs`, and the risk ladder lives in
`riskpolicy.mjs`. If you change them, re-run the backtest sweep first.

### Backtesting

```sh
node fetch_hist.mjs        # download daily OHLC for the universe -> hist.spot.1d.json
node sweep_spot.mjs        # parameter sweep over 180-day blocks (PASS / BUST counts)
```

## Files

| File | Purpose |
|---|---|
| `ctl.mjs` | CLI wrapper, rules, equity (with cross-check), state I/O, dashboard |
| `spot.mjs` | buy / sell / limit / cancel, fill parsing |
| `trader.mjs` | one cycle: reconcile → manage → entry → terminal check |
| `runner.mjs` | daemon loop, snapshots, failure handling, HALTED |
| `watchdog.sh` | keeps exactly one runner alive |
| `kspot`, `resume.sh`, `killprocs.sh` | start / post-reboot restore / stop |
| `riskpolicy.mjs` | equity-linked risk ladder + ratchet |
| `backtest.mjs`, `sweep_spot.mjs`, `fetch_*.mjs` | historical simulation |
| `scan.mjs` | quick hourly dip scan of the universe |
| `tests.mjs`, `validate.mjs` | unit tests, live consistency check |
| `docs/PLAN.md` | original design notes (Spanish, historical) |

## Results

Live paper run, 2026-10-18 → 2026-10-31:

- Equity **$995** (−0.5%).
- **8 closed trades, 1 winner** (net −$4.93).
- Six of those eight were forced exits caused by bugs fixed in v1.1, listed in
  [CHANGELOG](CHANGELOG.md):
  - false BUST liquidations from cash-only equity readings
  - untracked duplicate buys
- So far the sample says **nothing** about the strategy's edge either way.
