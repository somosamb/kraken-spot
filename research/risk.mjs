// Risk / capacity sweep on the unchanged v1.1 signal (docs/RESEARCH.md, findings 3-4).
// Usage: node research/risk.mjs
// Risk / capacity sweep on the unchanged live signal. Signal parameters are not fitted here.
import { datasets } from './data.mjs';
import { prepare, LIVE_V1 as LIVE, evaluate } from '../sweep_live.mjs';
const sets = {
  u24: prepare(datasets().u24),
  u43: prepare(datasets().u43),
};
const rows = [];
for (const [name, D] of Object.entries(sets))
for (const RISK_MULT of [1, 2, 3, 4, 6])
for (const CAP_MULT of [1, 2])
for (const MAXC of [2, 3, 4])
for (const NOTIONAL of [0.2, 0.35, 0.5]) {
  const P = { ...LIVE, RISK_MULT, CAP_MULT, MAXC, NOTIONAL };
  const all = evaluate(D, P, { from: 220, to: D.n - 30, step: 10 });
  const h1 = evaluate(D, P, { from: 220, to: 470, step: 10 });      // starts in first half
  const h2 = evaluate(D, P, { from: 470, to: D.n - 30, step: 10 }); // starts in second half
  rows.push({ name, P: { RISK_MULT, CAP_MULT, MAXC, NOTIONAL }, all, h1, h2 });
}
const f = e => `${e.pass}/${e.n} B${e.bust}`;
rows.sort((a, b) => (b.all.pPass - 3 * b.all.pBust) - (a.all.pPass - 3 * a.all.pBust));
for (const r of rows.slice(0, 25))
  console.log(r.name, JSON.stringify(r.P).padEnd(58), '| all', f(r.all).padEnd(9), 'med', String(r.all.medDays).padStart(4), 'd | h1', f(r.h1).padEnd(9), '| h2', f(r.h2).padEnd(9), '| tr/run', r.all.avgTrades.toFixed(1), 'medOpenEq', r.all.medOpenEq?.toFixed(0));
const base = rows.find(r => r.name === 'u24' && r.P.RISK_MULT === 1 && r.P.CAP_MULT === 1 && r.P.MAXC === 2 && r.P.NOTIONAL === 0.2);
console.log('BASELINE (live)', '| all', f(base.all), '| h1', f(base.h1), '| h2', f(base.h2), 'medOpenEq', base.all.medOpenEq?.toFixed(0));
console.log('max pass any row:', Math.max(...rows.map(r => r.all.pass)), 'rows with bust 0 and pass>0:', rows.filter(r => r.all.bust === 0 && r.all.pass > 0).length);
