#!/usr/bin/env node
/**
 * Fast challenge simulator mirroring the live trader rules, for parameter research.
 *
 * Question it answers: "starting with $1000 on day S, how often does the bot reach $1120
 * before $970?" — the challenge has no time limit, so each start runs to the end of data.
 *
 * Mirrors live: daily signals on completed bars, entry at the signal close, software stop
 * checked before the take-profit within a bar (conservative), BUST judged on intraday lows,
 * risk ladder + ratchet + $75 cap, 20% notional cap, correlation guard, win-rate freeze,
 * 0.26% fee per side.
 *
 * Usage:
 *   node sweep_live.mjs grid  [hist.json]           -> broad search, prints top configs
 *   node sweep_live.mjs eval  '<json params>' [hist.json] [fromDay] [toDay]
 */
import { readFileSync } from 'node:fs';
import { riskFor, ratchetFor, PORTFOLIO_CAP } from './riskpolicy.mjs';

const DIR = process.env.KS_DIR || new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const FEE = 0.0026, START = 1000, TARGET = 1120, FLOOR = 970;

/** Live configuration v1.0–1.1 (kept to reproduce docs/RESEARCH.md). */
export const LIVE_V1 = {
  strategy: 'dip', K: 1.25, STOP_ATR: 1.5, TARGET_ATR: 0.75, HOLD: 10, MIN_TP: 1.6,
  EMA200: true, REGIME: true, MAXC: 2, CORR: 0.65, RISK_MULT: 1, CAP_MULT: 1,
  NOTIONAL: 0.20, FREEZE: true, FREEZE_WR: 0.55, MIN_ATR_PCT: 0,
};
/** Live configuration v1.2: ATR floor 3%, risk ×3, 3 positions, 35% notional cap. */
export const LIVE = { ...LIVE_V1, MIN_ATR_PCT: 3, RISK_MULT: 3, MAXC: 3, NOTIONAL: 0.35 };

// ---- indicators (precomputed once per series) -------------------------------
function emaSeries(v, p) {
  const k = 2 / (p + 1), out = new Float64Array(v.length);
  let e = v[0];
  for (let i = 0; i < v.length; i++) { e = i === 0 ? v[0] : v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function atrSeries(b, p = 14) {   // same window as live atr(): mean TR of the last p bars
  const tr = b.map((x, i) => i === 0 ? x.high - x.low
    : Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)));
  const out = new Float64Array(b.length);
  let s = 0;
  for (let i = 0; i < b.length; i++) {
    s += tr[i];
    if (i >= p) s -= tr[i - p];          // keep the sum of tr[i-p+1..i]
    out[i] = i >= p ? s / p : 0;
  }
  return out;
}

export function prepare(hist) {
  const pairs = Object.keys(hist).filter(p => hist[p].length >= 300);
  const n = Math.max(...pairs.map(p => hist[p].length));
  const S = {};
  for (const p of pairs) {
    const raw = hist[p];
    const off = n - raw.length;                  // right-align shorter series
    const close = raw.map(b => b.close);
    S[p] = {
      off, bars: raw, close,
      e20: emaSeries(close, 20), e200: emaSeries(close, 200), atr: atrSeries(raw, 14),
      ret: close.map((c, i) => i ? c / close[i - 1] - 1 : 0),
    };
  }
  const btc = S['BTC/USD'];
  const regime = new Uint8Array(n);
  if (btc) for (let i = btc.off + 220; i < n; i++) {
    const j = i - btc.off;
    regime[i] = btc.close[j] > btc.e200[j] && btc.e200[j] > btc.e200[j - 20] ? 1 : 0;
  }
  return { pairs, n, S, regime };
}

function corr(sa, sb, i, w = 60) {
  const ia = i - sa.off, ib = i - sb.off;
  if (ia < w || ib < w) return 0;
  let ma = 0, mb = 0;
  for (let k = 0; k < w; k++) { ma += sa.ret[ia - k]; mb += sb.ret[ib - k]; }
  ma /= w; mb /= w;
  let num = 0, da = 0, db = 0;
  for (let k = 0; k < w; k++) {
    const x = sa.ret[ia - k] - ma, y = sb.ret[ib - k] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// ---- one challenge run from day `start` ------------------------------------
export function run(D, P, start, end = D.n) {
  const { S, pairs, regime } = D;
  const pos = {};
  let cash = START, trades = 0, wins = 0, sumR = 0, minEq = START;
  const log = P.TRADE_LOG;   // optional array: collects each closed trade's R multiple
  const bar = (p, i) => S[p].bars[i - S[p].off];
  for (let i = start; i < end; i++) {
    // manage (entries happen at close, so management starts the next bar)
    for (const p of Object.keys(pos)) {
      const q = pos[p], b = bar(p, i);
      let x = null;
      if (b.open <= q.stop) x = b.open;
      else if (b.low <= q.stop) {
        // STOP_FILL: 'stop' (exact), 'mid' (halfway to the bar low), 'low' (worst case: the low)
        x = P.STOP_FILL === 'low' ? b.low : P.STOP_FILL === 'mid' ? (q.stop + b.low) / 2 : q.stop;
      }
      else if (b.open >= q.tp) x = b.open;
      else if (b.high >= q.tp) x = q.tp;
      else if (i - q.day >= P.HOLD) x = b.close;
      if (x !== null) {
        cash += q.size * x * (1 - FEE);
        const net = q.size * (x - q.entry) - q.size * (q.entry + x) * FEE;
        trades++; if (net >= 0) wins++; sumR += net / q.risk;
        if (log) log.push(net / q.risk);
        delete pos[p];
      }
    }
    let eqClose = cash, eqLow = cash;
    for (const [p, q] of Object.entries(pos)) { const b = bar(p, i); eqClose += q.size * b.close; eqLow += q.size * b.low; }
    if (eqLow < minEq) minEq = eqLow;
    if (!P.NO_TERMINAL) {   // NO_TERMINAL: keep trading through PASS/BUST to measure the signal
      if (eqLow <= FLOOR) return { out: 'BUST', day: i - start, eq: eqLow, trades, wins, sumR, minEq };
      if (eqClose >= TARGET) return { out: 'PASS', day: i - start, eq: eqClose, trades, wins, sumR, minEq };
    }

    // entry
    if (P.FREEZE && trades > 15 && wins / trades < P.FREEZE_WR) continue;
    if (P.REGIME && !regime[i]) continue;
    const held = Object.keys(pos);
    if (held.length >= P.MAXC) continue;
    const cands = [];
    for (const p of pairs) {
      if (pos[p]) continue;
      const s = S[p], j = i - s.off;
      if (j < 220) continue;
      const a = s.atr[j], c = s.close[j];
      if (!(a > 0)) continue;
      if (P.EMA200 && !(c > s.e200[j])) continue;
      const ext = P.strategy === 'dip' ? (s.e20[j] - c) / a : (c - s.e20[j]) / a;
      if (ext < P.K) continue;
      if (100 * P.TARGET_ATR * a / c < P.MIN_TP) continue;
      if (P.MIN_ATR_PCT && 100 * a / c < P.MIN_ATR_PCT) continue;   // volatility floor (ATR % of price)
      if (held.some(h => Math.abs(corr(s, S[h], i)) > P.CORR)) continue;
      cands.push({ p, ext, c, a });
    }
    if (!cands.length) continue;
    cands.sort((x, y) => y.ext - x.ext);
    let used = 0;
    for (const q of Object.values(pos)) used += q.risk;
    const cap = PORTFOLIO_CAP * P.CAP_MULT;
    let allowed = Math.min(riskFor(eqClose) * ratchetFor(eqClose) * P.RISK_MULT, cap, Math.max(0, cap - used));
    for (const c of cands) {
      if (Object.keys(pos).length >= P.MAXC || allowed <= 0) break;
      const stopDist = P.STOP_ATR * c.a;
      let size = allowed / stopDist;
      if (size * c.c > eqClose * P.NOTIONAL) size = eqClose * P.NOTIONAL / c.c;
      if (size * c.c * (1 + FEE) > cash) size = cash / (c.c * (1 + FEE));
      if (size * c.c < 0.5) continue;
      cash -= size * c.c * (1 + FEE);
      const risk = size * stopDist;
      pos[c.p] = { size, entry: c.c, stop: c.c - stopDist, tp: c.c + P.TARGET_ATR * c.a, day: i, risk };
      allowed -= risk;
    }
  }
  let eq = cash;
  for (const [p, q] of Object.entries(pos)) eq += q.size * bar(p, end - 1).close * (1 - FEE);
  return { out: 'OPEN', day: end - start, eq, trades, wins, sumR, minEq };
}

/** Rolling starts every `step` days in [from, to); each runs to the end of data. */
export function evaluate(D, P, { from = 220, to = D.n - 30, step = 10, end = D.n } = {}) {
  const rs = [];
  for (let s = from; s < to; s += step) rs.push(run(D, P, s, end));
  const pass = rs.filter(r => r.out === 'PASS'), bust = rs.filter(r => r.out === 'BUST');
  const T = rs.reduce((s, r) => s + r.trades, 0), W = rs.reduce((s, r) => s + r.wins, 0);
  const R = rs.reduce((s, r) => s + r.sumR, 0);
  const days = pass.map(r => r.day).sort((a, b) => a - b);
  return {
    n: rs.length, pass: pass.length, bust: bust.length, open: rs.length - pass.length - bust.length,
    pPass: pass.length / rs.length, pBust: bust.length / rs.length,
    medDays: days.length ? days[Math.floor(days.length / 2)] : null,
    minEq: Math.min(...rs.map(r => r.minEq)),
    avgTrades: T / rs.length, winRate: T ? W / T : 0, expR: T ? R / T : 0,
    medOpenEq: (() => { const o = rs.filter(r => r.out === 'OPEN').map(r => r.eq).sort((a, b) => a - b); return o.length ? o[Math.floor(o.length / 2)] : null; })(),
  };
}

const fmt = (P, e) => `pass ${e.pass}/${e.n} bust ${e.bust}/${e.n} medDays ${e.medDays ?? '-'} trades/run ${e.avgTrades.toFixed(1)} win ${(e.winRate * 100).toFixed(0)}% expR ${e.expR.toFixed(3)} | ${JSON.stringify(P)}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode = 'grid', a1, a2, a3, a4] = process.argv.slice(2);
  if (mode === 'eval') {
    const P = { ...(process.env.BASE === 'v1' ? LIVE_V1 : LIVE), ...JSON.parse(a1 || '{}') };
    const D = prepare(JSON.parse(readFileSync(`${DIR}/${a2 || 'hist.spot.1d.json'}`, 'utf8')));
    const e = evaluate(D, P, { from: a3 ? +a3 : 220, to: a4 ? +a4 : D.n - 30 });
    console.log(fmt(P, e));
  } else if (mode === 'grid') {
    const D = prepare(JSON.parse(readFileSync(`${DIR}/${a1 || 'hist.spot.1d.json'}`, 'utf8')));
    const res = [];
    const t0 = Date.now();
    // optional sharding for parallel runs: SHARD=k/N evaluates every N-th config starting at k
    const [shardK, shardN] = (process.env.SHARD || '0/1').split('/').map(Number);
    let idx = -1;
    for (const strategy of ['dip', 'breakout'])
    for (const K of [0.75, 1.0, 1.25, 1.5, 2.0])
    for (const STOP_ATR of [1.0, 1.5, 2.0, 3.0])
    for (const TARGET_ATR of [0.5, 0.75, 1.0, 1.5, 2.0, 3.0])
    for (const HOLD of [5, 10, 20])
    for (const REGIME of [true, false])
    for (const EMA200 of [true, false])
    for (const RISK_MULT of [1, 2, 3])
    for (const MAXC of [2, 4]) {
      if (++idx % shardN !== shardK) continue;
      const P = { ...LIVE_V1, strategy, K, STOP_ATR, TARGET_ATR, HOLD, REGIME, EMA200, RISK_MULT, MAXC, FREEZE: false };
      // in-sample only: IS_END caps the data the search can see (default: all data)
      const isEnd = +(process.env.IS_END || D.n);
      res.push({ P, e: evaluate(D, P, { from: 220, to: isEnd - 30, end: isEnd }) });
    }
    console.error(`${res.length} configs in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const score = (e) => e.pPass - 2 * e.pBust;     // a bust costs twice what a pass gains
    res.sort((x, y) => score(y.e) - score(x.e));
    console.log(JSON.stringify(res.slice(0, 300)));
  }
}
