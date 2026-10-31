# Research: can any configuration realistically reach $1120?

*2026-10-31 · tool: [`sweep_live.mjs`](../sweep_live.mjs)*

**Short answer: not with the available data.**

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
node sweep_live.mjs eval '{}'                                            # live: 0/48 PASS, 0 BUST
node sweep_live.mjs eval '{"RISK_MULT":3,"MAXC":3,"NOTIONAL":0.35}'      # 1/48 PASS (exact fills)
node sweep_live.mjs eval '{"RISK_MULT":3,"MAXC":3,"NOTIONAL":0.35,"STOP_FILL":"mid"}'   # 0/48
IS_END=470 SHARD=0/1 node sweep_live.mjs grid > grid.json                # in-sample grid (~7 min)
```

## Open directions (not validated)

- **Per-pair notional cap scaled by volatility.** This would directly target the TRX-wick
  failure mode.
- **More history.** Two years with a single bull episode is too little. Another exchange's
  daily data, or Kraken trade history, could extend the test to several cycles.
- **Intraday signals.** More trades per year at the same edge would shorten the time to
  PASS without raising the risk per trade. The cost is that fees weigh more.
