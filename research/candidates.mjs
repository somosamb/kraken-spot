// Candidate deep-dive: history, minimum equity, trade bootstrap (docs/RESEARCH.md, finding 5).
// Usage: node research/candidates.mjs
// Detailed check of a few candidates: history (min equity, timing) + trade bootstrap stress test.
import { datasets } from './data.mjs';
import { prepare, LIVE_V1 as LIVE, evaluate, run } from '../sweep_live.mjs';
import { riskFor, ratchetFor, PORTFOLIO_CAP } from '../riskpolicy.mjs';

const sets = {
  u24: prepare(datasets().u24),
  u43: prepare(datasets().u43),
};
const C = [
  ['LIVE (actual)',            'u24', {}],
  ['A u24 x3 M3 N35',          'u24', { RISK_MULT: 3, MAXC: 3, NOTIONAL: 0.35 }],
  ['B u43 x3 M3 N35',          'u43', { RISK_MULT: 3, MAXC: 3, NOTIONAL: 0.35 }],
  ['C u43 x3 M3 N50',          'u43', { RISK_MULT: 3, MAXC: 3, NOTIONAL: 0.5 }],
  ['D u43 x4 M3 N35',          'u43', { RISK_MULT: 4, MAXC: 3, NOTIONAL: 0.35 }],
  ['E u43 x2 M3 N35',          'u43', { RISK_MULT: 2, MAXC: 3, NOTIONAL: 0.35 }],
];

// deterministic PRNG for reproducible bootstrap
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function bootstrap(Rs, mult, { paths = 20000, winPenalty = 0 } = {}) {
  const wins = Rs.filter(r => r >= 0), losses = Rs.filter(r => r < 0);
  const pW = wins.length / Rs.length - winPenalty;      // stress: lower the win rate
  let pass = 0, bust = 0, nTr = [];
  for (let k = 0; k < paths; k++) {
    let eq = 1000, n = 0;
    while (n < 3000) {
      const risk = Math.min(riskFor(eq) * ratchetFor(eq) * mult, PORTFOLIO_CAP);
      const r = rnd() < pW ? wins[Math.floor(rnd() * wins.length)] : losses[Math.floor(rnd() * losses.length)];
      eq += r * risk; n++;
      if (eq >= 1120) { pass++; nTr.push(n); break; }
      if (eq <= 970) { bust++; break; }
    }
  }
  nTr.sort((a, b) => a - b);
  return { pPass: pass / paths, pBust: bust / paths, medTrades: nTr[Math.floor(nTr.length / 2)] };
}

for (const [name, set, over] of C) {
  const D = sets[set];
  const P = { ...LIVE, ...over };
  const all = evaluate(D, P, { from: 220, to: D.n - 30, step: 10 });
  const h1 = evaluate(D, P, { from: 220, to: 470, step: 10 });
  const h2 = evaluate(D, P, { from: 470, to: D.n - 30, step: 10 });
  // trade sample for the bootstrap: whole tradable history, no terminal stop
  const Rs = [];
  run(D, { ...P, RISK_MULT: 1, NO_TERMINAL: true, TRADE_LOG: Rs }, 220);
  const tradesPerYear = Rs.length / ((D.n - 220) / 365);
  const b0 = bootstrap(Rs, P.RISK_MULT);
  const b10 = bootstrap(Rs, P.RISK_MULT, { winPenalty: 0.10 });
  const b20 = bootstrap(Rs, P.RISK_MULT, { winPenalty: 0.20 });
  const y = (t) => t ? (t / tradesPerYear * 12).toFixed(0) + 'm' : '-';
  console.log(`${name.padEnd(18)} hist: PASS ${all.pass}/${all.n} BUST ${all.bust} (h1 ${h1.pass}/${h1.n}, h2 ${h2.pass}/${h2.n}) medDays ${all.medDays ?? '-'} minEq $${all.minEq.toFixed(0)}`);
  console.log(`${''.padEnd(18)} trades ${Rs.length} (${tradesPerYear.toFixed(1)}/yr) win ${(Rs.filter(r => r >= 0).length / Rs.length * 100).toFixed(0)}% expR ${(Rs.reduce((s, r) => s + r, 0) / Rs.length).toFixed(2)}`);
  console.log(`${''.padEnd(18)} bootstrap: as-is pass ${(b0.pPass * 100).toFixed(0)}% bust ${(b0.pBust * 100).toFixed(1)}% (~${y(b0.medTrades)}) | win-10pt pass ${(b10.pPass * 100).toFixed(0)}% bust ${(b10.pBust * 100).toFixed(1)}% | win-20pt pass ${(b20.pPass * 100).toFixed(0)}% bust ${(b20.pBust * 100).toFixed(1)}%`);
}
