// Signal-quality search, risk-independent (docs/RESEARCH.md, finding 2). Shard: SHARD=k/N
// Usage: node research/robust.mjs > rob.json
// Signal-quality search: risk-independent edge (expR) and frequency, on three data sets.
import { datasets } from './data.mjs';
import { prepare, LIVE_V1 as LIVE, evaluate } from '../sweep_live.mjs';

const spot = datasets().u24;
const other = datasets().other;
const Ds = prepare(spot), Do = prepare(other);
const [k, N] = (process.env.SHARD || '0/1').split('/').map(Number);
const out = [];
let idx = -1;
for (const strategy of ['dip', 'breakout'])
for (const K of [0.5, 0.75, 1.0, 1.25, 1.5, 2.0])
for (const STOP_ATR of [1.0, 1.5, 2.0, 3.0])
for (const TARGET_ATR of [0.5, 0.75, 1.0, 1.5, 2.0])
for (const HOLD of [5, 10, 20])
for (const REGIME of [true, false])
for (const EMA200 of [true, false]) {
  if (++idx % N !== k) continue;
  // RISK_MULT 1, MAXC 2, no freeze: measure the signal, not the sizing
  const P = { ...LIVE, strategy, K, STOP_ATR, TARGET_ATR, HOLD, REGIME, EMA200, FREEZE: false };
  // one long run per set from the first tradable day: trade stats only (PASS ignored)
  const big = { ...P, RISK_MULT: 1, NO_TERMINAL: true };
  const is = evaluate(Ds, big, { from: 220, to: 221, end: 470 });
  const oos = evaluate(Ds, big, { from: 470, to: 471, end: Ds.n });
  const uni = evaluate(Do, big, { from: 220, to: 221, end: Do.n });
  out.push({ P, is: [is.avgTrades, is.expR, is.winRate], oos: [oos.avgTrades, oos.expR, oos.winRate], uni: [uni.avgTrades, uni.expR, uni.winRate] });
}
console.log(JSON.stringify(out));
