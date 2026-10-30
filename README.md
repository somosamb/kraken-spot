# Kraken Spot Paper — Autonomous Trading Bot

A small, self-hosted bot that operates a **Kraken Spot Paper** workspace
($1000 starting balance, +12% profit target, -3% loss floor) using the
`kraken` CLI. It is the spot-paper counterpart of a futures "get funded"
challenge, adapted to spot's constraints (long-only, 0.26% fees per side,
no native stop/take-profit orders — protection is done by polling).

## What it does

- **Signal (daily bars):** buys the dip in an uptrend — price below EMA20
  by `K` ATR, while price > EMA200 and BTC regime is bullish.
- **Risk:** dynamic per-trade risk that grows with equity (ratchet), capped
  per position (20% notional) and total (40% portfolio risk units).
- **Protection:** software stops + resting limit-sell take-profits, time
  stops (10 days), correlation filter, max 2 concurrent positions.
- **Self-preservation:** auto-freezes entries if win rate < 55% after 15
  trades; watchdog + runner restart on crash; failure sentinel + backoff.
- **Auditability:** `state.json`, `trades.jsonl`, `equity.csv`, `bot.log`,
  plus `validate.mjs` and `tests.mjs`.

## Files

| File | Purpose |
|---|---|
| `ctl.mjs` | Kraken wrapper, rules, equity, sizing, reporting |
| `spot.mjs` | Spot paper buy/sell/cancel helpers |
| `trader.mjs` | One cycle: manage positions + entries |
| `runner.mjs` | Daemon (45s tick, 600s cycle timeout, 8-failure halt) |
| `watchdog.sh` | Revives runner if it dies |
| `riskpolicy.mjs` | Equity-linked risk ladder + ratchet |
| `backtest.mjs` / `sweep_spot.mjs` | Historical simulation & parameter sweep |
| `validate.mjs` / `tests.mjs` | Consistency checks & unit tests |
| `kspot` / `resume.sh` | Manual revival helpers |
| `scan.mjs` | Quick universe scan |

## Requirements

- Node.js 18+
- Kraken CLI (`kraken`) installed and a `spotbot` paper workspace created
  with $1000 capital:
  `kraken paper create --workspace spotbot --capital 1000`
- Workspace name is `spotbot` (see `ctl.mjs`).

## Usage

```sh
# run unit tests
node tests.mjs

# consistency check
node validate.mjs

# one trading cycle (no entries)
node trader.mjs loop noentry

# one trading cycle (with entries)
node trader.mjs loop

# daemon
node runner.mjs            # or: node runner.mjs noentry

# watchdog
sh watchdog.sh

# status
node ctl.mjs status
node ctl.mjs json
```

## Configuration

Key constants live at the top of `trader.mjs` (`K`, `STOP_ATR`,
`TARGET_ATR`, `MAX_CONCURRENT`, `HOLD_MAX_DAYS`, `CORR_MAX`, ...) and in
`riskpolicy.mjs`. Change them deliberately and re-run `sweep_spot.mjs` first.

## Notes

- Spot paper has **no native stops**. The runner is the stop; keep it and the
  watchdog alive. Resting limit-sell take-profits provide passive protection.
- All paths default to `/home/oc/kraken-spot` and `/home/oc/bin/kraken`;
  adjust `DIR`/`KRAKEN` if you install elsewhere.
- Runtime files (`state.json`, `trades.jsonl`, `equity.csv`, `*.log`, caches)
  are gitignored.

