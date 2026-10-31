# Research: can any configuration realistically reach $1120?

*2026-10-31 · tool: [`sweep_live.mjs`](../sweep_live.mjs)*

> **Update (v1.2, same day).** The screening evaluation below found a volatility floor
> (ATR ≥ 3%) that changes the conclusion. The live configuration now uses it with ×3 risk.
> Findings 1–5 describe the v1.1 configuration (`BASE=v1`).

**Short answer for v1.1: not with the available data.**

- No configuration reaches +12% with a meaningful probability while staying safe under
  realistic stop fills.
- The current configuration is already close to the best risk-adjusted signal.
- What limits it is how often it trades, not whether the signal works.

## Method

**Data.** 2 years of daily bars, 2024-10-28 → 2026-10-18. That is 721 bars, the most the
Kraken API returns. Two universes:

- the 24 live majors
- 43 pairs: the same 24 plus 19 extra pairs from `hist.universe700.1d.json`, which were
  never used to tune anything

**Simulator.** `sweep_live.mjs` mirrors the live rules:

| Rule | How it is modelled |
|---|---|
| Indicators | Identical to `trader.mjs` (verified, relative error ~1e-14) |
| Entries | Taken at the close of the signal bar |
| Stop vs. target | The stop is checked before the target within a bar |
| BUST | Judged on intraday lows |
| Risk | Ladder + ratchet + $75 cap, plus a 20% notional cap |
| Filters | Correlation guard, win-rate freeze |
| Fees | 0.26% per side |

It reproduces the live configuration's backtest: 0 PASS, 0 BUST.

**Metric.** The challenge has no time limit. So the bot is started with $1000 every 10 days
(48 starts), each start runs to the end of the data, and every run is classified as PASS,
BUST or still open.

**Guarding against overfitting**

| Step | What it checks |
|---|---|
| Time split | The grid search only saw days 0–470. Days 470–721 were held out. |
| Pair split | The 19 extra pairs were never seen during the search. |
| Stop-fill stress | The software stop fills at the stop price (`stop`), halfway to the bar low (`mid`), or at the bar low (`low`). |
| Bootstrap | Trade outcomes are resampled to create losing streaks the history didn't have. |

## Findings

**1. The best grid configurations are overfit.** The top in-sample configurations reached
4–5 PASS out of 22 with 0 BUST. They used dip entries, a 1 ATR stop and ×3 risk.

| Data | PASS |
|---|---|
| Held-out half | 0/23 |
| Unseen pairs | 0–1/48 |
| Unseen pairs, 4 concurrent positions | 0–1/48, with 11–15 BUSTs |

**2. The live signal is already near the top on risk-adjusted terms.**

| Signal | Edge (R/year), weakest of the 3 data sets | Expectancy per trade (IS / OOS-time / OOS-pairs) |
|---|---|---|
| **live** (dip K1.25, S1.5, T0.75, BTC regime, EMA200) | 2.5 | +0.19 / +0.43 / +0.28 R, win rate 87–100% |
| best "robust" alternative | 3.2 | +0.07 / +0.50 / +0.10 R |
| live without the BTC regime filter | — | +0.11 / **+0.02** / +0.29 R |

The best alternative is barely better and much weaker in-sample. Removing the BTC regime
filter collapses the expectancy in the held-out period, so the filter earns its place.

**3. Sizing up the unchanged live signal looks great with exact stop fills.**

| Configuration | PASS | BUST | Median days to PASS |
|---|---|---|---|
| live | 0/48 | 0 | — |
| 43 pairs, ×3 risk, 3 positions, 50% notional | 9/48 | 0 | 78 |

But every PASS starts in the 2025 bull phase, which is a single episode. The bear-phase
starts end 0 PASS / 0 BUST: the regime filter keeps the bot flat.

**4. Realistic fills remove most of the result.**

| Configuration | exact | mid | low (worst case) |
|---|---|---|---|
| 43 pairs ×3, 35% notional | P4 B0 | P2 **B7** | P2 **B9** (min equity $750) |
| 43 pairs ×4, 35% notional | P8 B0 | P6 **B5** | P3 **B10** |
| 24 pairs ×3, 3 positions, 35% notional | P1 B0 | P0 B0 | P0 B0 (min equity $976) |

- The extra pairs are smaller alts with flash wicks. With the 24 majors, **no
  configuration reached a PASS under worst-case fills while also avoiding BUST**:
  - 62 of 168 configurations stay safe under all three fill models, and none of them
    passes under `low` fills
  - 106 of 168 configurations bust under `low` fills
- Every worst-case BUST in the 24-pair set comes from one day: 2025-09-06, a −10%
  intraday wick on **TRX**. A low-volatility coin gets a large position from risk-based
  sizing (small ATR), so a single wick is enough to eat the cushion.

**5. Losing streaks are not the danger.** The risk ladder sizes each trade as a fraction of
the remaining cushion, so repeated full-R losses can never reach the floor. Even with the
win rate cut by 20 points, the bootstrap shows 0% BUST. The real BUST channels are
**fills far worse than the stop** (wicks, a polling software stop) and **several positions
losing at once**.

## Why it is structurally hard

The rules are asymmetric: +12% to PASS against −3% to BUST, long-only, with 0.52%
round-trip fees and no native stop orders.

- Reaching +12% with a +0.3 R edge needs either many trades or a large risk per trade.
- This signal fires about 14 times a year, almost only in bull regimes.
- Larger risk per trade turns a single bad fill into a BUST.

## Reproduce

```sh
BASE=v1 node sweep_live.mjs eval '{}'                                                # v1.1: 0/48 PASS, 0 BUST
BASE=v1 node sweep_live.mjs eval '{"RISK_MULT":3,"MAXC":3,"NOTIONAL":0.35}'          # 1/48 PASS (exact fills)
BASE=v1 node sweep_live.mjs eval '{"RISK_MULT":3,"MAXC":3,"NOTIONAL":0.35,"STOP_FILL":"mid"}'   # 0/48
node sweep_live.mjs eval '{"STOP_FILL":"low"}'                                       # v1.2: 9/48 PASS, 0 BUST
IS_END=470 SHARD=0/1 node sweep_live.mjs grid > grid.json                # in-sample grid (~7 min)
node research/robust.mjs > rob.json     # finding 2: signal quality on 3 data sets (~10 min; SHARD=k/N to parallelise)
node research/risk.mjs                  # findings 3-4: risk / capacity sweep on the v1.1 signal
node research/candidates.mjs            # finding 5: minimum equity + trade bootstrap (~3 min)
node research/screen.mjs u24            # screening evaluation (use u43 for the 43-pair cross-check)
```

## Screening evaluation (v1.2)

This is an event study. For every pair and day, it simulates the trade the live rules
would open and measures what each screening stage adds. It covers the 24 majors, then the
43-pair set as a cross-check.

| Stage | Evidence (24 / 43 pairs) | Verdict |
|---|---|---|
| Pair EMA200 | without it, 0.00 / +0.01 R per trade; with it, +0.27 / +0.26 R | the key filter |
| BTC regime | raises expectancy from +0.14 to +0.27 R; the signals it rejects average −0.33 / −0.22 R | keep |
| Dip threshold K = 1.25 | below it, ~0 R in every bucket; from 1.25, +0.19, and +0.33 for 1.5–2 ATR | well placed |
| Rank by deepest dip | on days with several signals, the pick averages +0.41 / +0.37 R, against +0.29 for the average signal and +0.26 for the shallowest | keep |
| `MIN_TP` 1.6% | rejected only 7 signals, and all 7 won | inert; kept as a guard |
| Correlation guard (full history) | blocked 61% of pair combinations. TRX is the least correlated pair (0.16–0.18), so it was always allowed as a second position. | changed to a 60-day window |
| Universe | 11 of the 24 pairs never produced a signal in 2 years (always below their EMA200) | harmless |
| **Volatility below 3% ATR** | −0.13 R, or −0.23 R with mid stop fills. Mostly TRX (−0.37 R per trade). | **new filter** |

In the challenge simulation (24 pairs, worst-case `low` stop fills), the volatility floor
behaves like this:

| | ×1 risk | ×3 risk, 3 positions, 35% notional |
|---|---|---|
| no floor | 0 PASS, 0 BUST, minimum equity $993 | 0 PASS, 0 BUST, minimum equity $976 |
| ATR ≥ 3% | 0 PASS, 0 BUST, minimum equity $998 | **9 PASS, 0 BUST, minimum equity $993** |

How stable is it? Results by ATR threshold, at ×3–×4 risk with `low` fills:

| ATR threshold | PASS / 48 | BUST |
|---|---|---|
| 2.5% | 0 | up to 2 |
| 2.75–3.25% | 8–10 | 0 |
| 3.5% | 1–6 | 0 |

The cliff at 2.75% is the TRX boundary, since TRX's ATR averages 2.9% of price. **Treat
the filter as "exclude the quiet, wick-prone pairs".** It is not a finely tuned optimum.

**Live implementation issues found and fixed during this review:**

1. **Signals lagged by one day.** `barsFrom` used `time < last`, but Kraken's `last` is the
   open time of the last *completed* candle, so the filter also dropped yesterday's candle.
   - Delaying entry by one day cuts the expectancy from +0.26 to +0.13 R per trade (from
     +0.32 to +0.17 R with the ATR floor).
   - The three positions open when v1.2 shipped (BTC, ARB, NEAR) would not pass the
     corrected screen.
2. **Same-day re-entry.** After a stop, the next cycle could buy the same pair again on the
   same stale signal. A cooldown until the next UTC day now prevents this.
3. **Stale price.** Entries now require the live price to be within 0.5 ATR of the signal
   close.
4. **Correlation inside one cycle.** It was only checked against positions held *before*
   the cycle. It now also includes positions opened earlier in the same cycle.

## Open directions (not validated)

- **Per-pair notional cap scaled by volatility.** This would directly target the TRX-wick
  failure mode.
- **More history.** Two years with a single bull episode is too little. Another exchange's
  daily data, or Kraken trade history, could extend the test to several cycles.
- **Intraday signals.** More trades per year at the same edge would shorten the time to
  PASS without raising the risk per trade. The cost is that fees weigh more.
