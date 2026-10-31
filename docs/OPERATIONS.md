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
| `FROZEN` | bot, when the win rate is below 55% over more than 15 trades | No new entries | Clears itself when the win rate recovers. `node trader.mjs unfreeze` forces it. |
| `FAILURE_SENTINEL` | runner, on a failed cycle | Informational | Clears itself on the next good cycle |

The mode (`ENTRY_ENABLED`) is read when the runner starts, so restart after changing it.

## Logs and data

| File | Content |
|---|---|
| `bot.log` | One line per cycle: `eq=… pnl=… prog=… pos=…`, plus errors and alerts. Rotated to `bot.log.1` at 5 MB. |
| `alerts.log` | Trade closes, `STATS` every 5 trades, `RECONCILE`, `FREEZE`, `HALTED` |
| `trades.jsonl` | Ledger, one closed trade per line: `seq, symbol, entry, exit, size, gross, fees, net, reason, openedAt`. Deduplicated by `symbol\|openedAt`. |
| `equity.csv` | Equity snapshot every cycle: `ts, equity, pnl_pct, progress_to_target, source, note`. Grows without limit, so archive it from time to time. |
| `state.json` | Open positions (entry, stop, TP, TP order id), peak and trough, trade counter |
| `runner.state.json` | Last cycle number, timestamp, status |
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

## Troubleshooting

| You see | Meaning | Action |
|---|---|---|
| `src=own(venue $X rejected)` in `bot.log` | The venue's equity figure disagreed with our valuation, so ours was used | Nothing, unless it persists. Then compare `kraken paper status` with `kraken paper balance`. |
| `terminal reading not confirmed, ignored` | One PASS/BUST reading did not repeat | Nothing. It was a glitch. |
| `RECONCILE …: adopted untracked …` | A holding existed without a tracked position. The bot adopted it with an entry taken from trade history and a fresh stop/TP. | Check `state.json`. This usually means a cycle was killed right after a buy. |
| `RECONCILE …: cannot adopt yet` | No trade history or ATR was available for that holding | The bot retries each cycle. If it persists, sell the holding by hand. |
| `cycle N failed …` repeated, `FATAL` | Every cycle fails, usually because the CLI or network is down | Run `kraken paper status -o json` by hand. The watchdog restarts the runner automatically. |
| `validate` FAIL: untracked / missing / size mismatch | State and exchange disagree | Wait one cycle (reconcile fixes it). If it persists, run `npm run cycle:dry` and read `alerts.log`. |
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
