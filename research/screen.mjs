// Event study of the screening pipeline (docs/RESEARCH.md, 'Screening evaluation').
// Usage: node research/screen.mjs [u24|u43]
// Event study of the live screening pipeline: for every (pair, day) compute the screening
// features and the outcome (net R) of the trade the live rules would open at that close.
import { datasets } from './data.mjs';
import { prepare } from '../sweep_live.mjs';

const FEE = 0.0026, K = 1.25, STOP = 1.5, TP = 0.75, HOLD = 10, MIN_TP = 1.6;
const setName = process.argv[2] || 'u24';
const hist = datasets()[setName];
const D = prepare(hist);
const { S, regime, n } = D;

function outcome(s, j, fill = 'stop') {
  const c = s.close[j], a = s.atr[j], stop = c - STOP * a, tp = c + TP * a;
  for (let k = j + 1; k < s.bars.length; k++) {
    const b = s.bars[k];
    let x = null;
    if (b.open <= stop) x = b.open;
    else if (b.low <= stop) x = fill === 'mid' ? (stop + b.low) / 2 : stop;
    else if (b.open >= tp) x = b.open;
    else if (b.high >= tp) x = tp;
    else if (k - j >= HOLD) x = b.close;
    if (x !== null) {
      const net = (x - c) - (c + x) * FEE;
      return { R: net / (STOP * a), win: net >= 0, days: k - j, exitDay: k };
    }
  }
  return null;
}

const ev = [];
for (const [p, s] of Object.entries(S)) {
  for (let j = 220; j < s.bars.length - 1; j++) {
    const i = j + s.off;
    const a = s.atr[j], c = s.close[j];
    if (!(a > 0)) continue;
    const ext = (s.e20[j] - c) / a;
    if (ext < 0.5) continue;                     // keep a margin below K for near-miss analysis
    const o = outcome(s, j), om = outcome(s, j, 'mid');
    if (!o) continue;
    ev.push({ p, i, ext, reg: !!regime[i], e200: c > s.e200[j], tpPct: 100 * TP * a / c,
      atrPct: 100 * a / c, R: o.R, win: o.win, Rmid: om.R, days: o.days });
  }
}

const st = (xs, key = 'R') => {
  if (!xs.length) return '   n=0';
  const m = xs.reduce((s, e) => s + e[key], 0) / xs.length;
  const w = xs.filter(e => e.R >= 0).length / xs.length;
  const eps = new Set(xs.map(e => e.p + '|' + Math.floor(e.i / 5))).size;  // ~independent episodes
  return `n=${String(xs.length).padStart(4)} ep~${String(eps).padStart(3)} meanR=${m.toFixed(3).padStart(6)} win=${(w * 100).toFixed(0).padStart(3)}%`;
};
const live = e => e.ext >= K && e.reg && e.e200 && e.tpPct >= MIN_TP;
console.log(`== ${setName}: ${Object.keys(S).length} pairs, ${ev.length} events with ext>=0.5 ==\n`);

console.log('1) Filter ablation (all with ext >= K):');
const base = ev.filter(e => e.ext >= K);
console.log('  dip only (ext>=K)                 ', st(base));
console.log('  + BTC regime                       ', st(base.filter(e => e.reg)));
console.log('  + pair EMA200                      ', st(base.filter(e => e.reg && e.e200)));
console.log('  + MIN_TP (= LIVE)                  ', st(base.filter(live)));
console.log('  LIVE minus regime                  ', st(base.filter(e => e.e200 && e.tpPct >= MIN_TP)));
console.log('  LIVE minus pair EMA200             ', st(base.filter(e => e.reg && e.tpPct >= MIN_TP)));
console.log('  LIVE minus MIN_TP                  ', st(base.filter(e => e.reg && e.e200)));
console.log('  rejected by regime only            ', st(base.filter(e => !e.reg && e.e200 && e.tpPct >= MIN_TP)));
console.log('  rejected by MIN_TP only            ', st(base.filter(e => e.reg && e.e200 && e.tpPct < MIN_TP)));
console.log('  LIVE with mid stop fills           ', st(base.filter(live), 'Rmid'));

console.log('\n2) Ranking key: ext bucket (regime + EMA200 + MIN_TP applied):');
const f3 = ev.filter(e => e.reg && e.e200 && e.tpPct >= MIN_TP);
for (const [lo, hi] of [[0.5, 0.75], [0.75, 1.0], [1.0, 1.25], [1.25, 1.5], [1.5, 2.0], [2.0, 3.0], [3.0, 99]])
  console.log(`  ext ${String(lo).padEnd(4)}-${String(hi === 99 ? '+' : hi).padEnd(4)}`, st(f3.filter(e => e.ext >= lo && e.ext < hi)), lo < K ? '  (below K: near-miss)' : '');

console.log('\n3) Volatility (ATR% of price) among LIVE signals:');
const L = ev.filter(live);
for (const [lo, hi] of [[0, 3], [3, 4], [4, 5], [5, 7], [7, 99]])
  console.log(`  ATR% ${String(lo).padEnd(2)}-${String(hi === 99 ? '+' : hi).padEnd(3)}`, st(L.filter(e => e.atrPct >= lo && e.atrPct < hi)), ' midR', (L.filter(e => e.atrPct >= lo && e.atrPct < hi).reduce((s, e) => s + e.Rmid, 0) / Math.max(1, L.filter(e => e.atrPct >= lo && e.atrPct < hi).length)).toFixed(3));

console.log('\n4) Same-day competition: when several LIVE signals fire on one day, which does best?');
const byDay = {};
for (const e of L) (byDay[e.i] ||= []).push(e);
const multi = Object.values(byDay).filter(x => x.length >= 2);
const pick = (fn) => multi.map(x => [...x].sort(fn)[0]);
const mean = xs => (xs.reduce((s, e) => s + e.R, 0) / xs.length).toFixed(3);
console.log(`  days with >=2 signals: ${multi.length} (of ${Object.keys(byDay).length} signal days); signals/day on those: ${(multi.reduce((s, x) => s + x.length, 0) / multi.length).toFixed(1)}`);
console.log('  rank by highest ext (LIVE)   meanR', mean(pick((a, b) => b.ext - a.ext)));
console.log('  rank by lowest ext           meanR', mean(pick((a, b) => a.ext - b.ext)));
console.log('  rank by highest ATR%         meanR', mean(pick((a, b) => b.atrPct - a.atrPct)));
console.log('  rank by lowest ATR%          meanR', mean(pick((a, b) => a.atrPct - b.atrPct)));
console.log('  average of all candidates    meanR', mean(multi.flat()));

console.log('\n5) Per pair (LIVE signals):');
const byPair = {};
for (const e of L) (byPair[e.p] ||= []).push(e);
const rows = Object.entries(byPair).map(([p, xs]) => [p, xs, xs.reduce((s, e) => s + e.R, 0) / xs.length]).sort((a, b) => b[2] - a[2]);
for (const [p, xs] of rows) console.log(`  ${p.padEnd(10)}`, st(xs), ' atr%', (xs.reduce((s, e) => s + e.atrPct, 0) / xs.length).toFixed(1));
const never = Object.keys(S).filter(p => !byPair[p]);
console.log('  pairs that never produced a LIVE signal:', never.join(' ') || '-');

console.log('\n6) Signal persistence: consecutive days the same pair keeps signalling (LIVE):');
let runs = [], cur = 0, prev = null;
for (const e of [...L].sort((a, b) => a.p.localeCompare(b.p) || a.i - b.i)) {
  if (prev && prev.p === e.p && e.i === prev.i + 1) cur++; else { if (prev) runs.push(cur + 1); cur = 0; }
  prev = e;
}
if (prev) runs.push(cur + 1);
console.log(`  episodes ${runs.length}, mean length ${(runs.reduce((s, x) => s + x, 0) / runs.length).toFixed(2)} days, max ${Math.max(...runs)}`);
