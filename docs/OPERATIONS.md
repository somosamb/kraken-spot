# Operations runbook

All commands run from the repo directory, or from `KS_DIR` if you set it.

## Start, stop, check

| Task | Command |
|---|---|
| Start (idempotent) | `npm start` (runs `sh kspot`) |
| Stop | `npm stop`. Stops the watchdog first so it can't revive the runner. |
| Dashboard | `npm run status` |
| Full health check | `npm run validate` (exit 0 = consistent) |
| One manual cycle, no new trades | `npm run cycle:dry` |
| Close positions by hand | `npm stop`, then `node trader.mjs close all` (or `close BTC/USD …`), then `npm start`. Cancels the TP, sells at market, books the trade with reason `manual` and sets the cooldown. |
| After a reboot | `sh resume.sh` (start, wait one cycle, then validate and run the tests) |

To keep the bot alive across crashes and reboots, run `kspot` from cron. It does nothing
if everything is up, and nothing if the bot is `HALTED`.

```cron
*/5 * * * * sh /path/to/kraken-spot/kspot >/dev/null 2>&1
@reboot     sh /path/to/kraken-spot/kspot >/dev/null 2>&1
```

A healthy system shows:

- exactly **1** runner and **1** watchdog
- `runner.state.json` updated within the last ~2 min
- `src venue` on the dashboard

## Control files

| File | Created by | Effect | Clear it |
|---|---|---|---|
| `ENTRY_ENABLED` | you | Runner opens new trades. Without it the runner only manages open positions. | `rm` it, then `npm stop && npm start` |
| `HALTED` | bot, on a confirmed PASS/BUST | Runner, watchdog and `kspot` refuse to run | `rm HALTED` after reviewing |
| `FROZEN` | bot, when the win rate is below 55% over more than 15 strategy trades (`stop`, `target`, `target_fill`, `timestop` since 2026-10-31 14:15 UTC) | No new entries | Clears itself when the win rate recovers. `node trader.mjs unfreeze` forces it. |
| `FAILURE_SENTINEL` | runner, on a failed cycle | Informational | Clears itself on the next good cycle |

The mode (`ENTRY_ENABLED`) is read when the runner starts, so restart after changing it.

## Logs and data

| File | Content |
|---|---|
| `bot.log` | One line per cycle: `eq=… pnl=… prog=… pos=… near=[…]`, plus errors and alerts. Rotated to `bot.log.1` at 5 MB. |
| `alerts.log` | Trade closes, `STATS` every 5 trades, `RECONCILE`, `FREEZE`, `HALTED` |
| `trades.jsonl` | Ledger, one closed trade per line: `seq, symbol, entry, exit, size, gross, fees, net, reason, openedAt`. Deduplicated by `symbol\|openedAt`. |
| `equity.csv` | Equity snapshot every cycle: `ts, equity, pnl_pct, progress_to_target, source, note`. Grows without limit, so archive it from time to time. |
| `state.json` | Open positions (entry, stop, TP, TP order id), peak and trough, trade counter |
| `runner.state.json` | Last cycle number, timestamp, status |
| `net.state.json` | Network monitor state and last observation |
| `kraken-calls.log` | Slow, failed or lock-retried CLI calls (diagnostics) |
| `watchdog.log` | Runner restarts |

Possible close reasons in the ledger:

| Reason | Meaning |
|---|---|
| `stop` | software stop hit |
| `target` | price reached the take-profit and the bot sold |
| `target_fill` | the resting take-profit order filled on the exchange |
| `timestop` | position held for 10 days |
| `external_close` | position closed outside the bot |
| `pass` / `bust` | flattened on a confirmed terminal verdict |
| `manual` | closed by hand with `node trader.mjs close` |

## Network monitor

The bot runs on a phone, so connectivity is monitored on every cycle.

**Inputs:**
- the CLI calls of the previous cycle: latency, plus network errors and network warnings
  on stderr
- a direct probe to `api.kraken.com/0/public/Time` (5 s limit)
- whether the last cycle completed
- the time since the previous cycle

| State | Entered when | Entries |
|---|---|---|
| `OK` | No problems | allowed |
| `DEGRADED` | Any of these: a network error, call p90 above 2.5 s, a failed probe, a failed cycle, or more than 120 s between cycles | **blocked** |
| `INTERMITTENT` | 3 incidents within one hour | blocked; needs 30 clean minutes to clear |
| `OFFLINE` | No cycle for more than 5 min, or the probe is down and 2 cycles failed in a row | blocked (and nothing reaches the exchange anyway) |

- **Recovery:** returning to `OK` takes 5 good cycles in a row (~5 min).
- **What you see on each state change:**
  - a `NET A -> B (reason)` line in `bot.log` and `alerts.log`
  - a phone notification (Termux, `KS_NOTIFY=0` to disable)
  - the `net` line on the dashboard
  - `net=STATE` on every log line, with `(noentry)` added while entries are blocked
- **After a restart:** the first cycle measures the gap since the runner last ran. Any
  downtime longer than 5 min therefore shows up as `OFFLINE` and has to recover like any
  other incident.
- **Files:**
  - `net.state.json`: the current state and the last observation
  - `kraken-calls.log`: every CLI call that was slow (> 3 s), failed, or needed lock retries

## Reading `near=[…]`

`near` lists the five deepest dips among pairs the bot does not hold, as `PAIR:depth(tag)`.
The depth is in ATRs below EMA20. A pair with no tag is a valid candidate.

| Tag | Meaning |
|---|---|
| `regime` | Valid on its own, but the BTC regime is off |
| `downtrend` | Price is below the pair's EMA200 |
| `shallow` | The dip is less than K = 1.25 ATR |
| `lowvol` | ATR is below 3% of price |
| `fees` | The target is below 1.6% |
| `cooldown` | The pair was closed earlier today (UTC) |
| `corr:XXX` | Correlated above 0.65 with held position XXX |
| `drift` | The live price moved more than 0.5 ATR from the signal close |
| `full` | 3 positions are already open, or the risk budget is used up |

## Troubleshooting

| You see | Meaning | Action |
|---|---|---|
| `src=own(venue $X rejected)` in `bot.log` | The venue's equity figure disagreed with our valuation, so ours was used | Nothing, unless it persists. Then compare `kraken paper status` with `kraken paper balance`. |
| `terminal reading not confirmed, ignored` | One PASS/BUST reading did not repeat | Nothing. It was a glitch. |
| `RECONCILE …: adopted untracked …` | A holding existed without a tracked position. The bot adopted it with an entry taken from trade history and a fresh stop/TP. | Check `state.json`. This usually means a cycle was killed right after a buy. |
| `RECONCILE …: cannot adopt yet` | No trade history or ATR was available for that holding | The bot retries each cycle. If it persists, sell the holding by hand. |
| `cycle N failed …` repeated, `FATAL` | Every cycle fails, usually because the CLI or network is down | Run `kraken paper status -o json` by hand. The watchdog restarts the runner automatically. |
| `validate` FAIL: untracked / missing / size mismatch | State and exchange disagree | Wait one cycle (reconcile fixes it). If it persists, run `npm run cycle:dry` and read `alerts.log`. |
| `net=DEGRADED(noentry)` or `NET … -> OFFLINE` | Weak or lost signal. The bot keeps managing positions but opens none. | Nothing. It recovers by itself after 5 good cycles (30 clean minutes if `INTERMITTENT`). Check `kraken-calls.log` for details. |
| More than 1 runner or watchdog | Should not happen (`flock`) | `npm stop`, check `pgrep -af runner.mjs`, then `npm start` |

## Reset the challenge

This wipes the bot's history. Stop the bot first.

```sh
npm stop
kraken paper reset spotbot
mkdir -p archive && mv state.json trades.jsonl equity.csv alerts.log bot.log* archive/ 2>/dev/null
rm -f HALTED FROZEN FAILURE_SENTINEL runner.state.json
npm start
```
