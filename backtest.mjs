#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const DIR = process.env.KS_DIR || new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const HIST_FILE = process.env.HIST_FILE || 'hist.spot.1d.json';
const hist = JSON.parse(readFileSync(`${DIR}/${HIST_FILE}`, 'utf8'));
const UNIVERSE = Object.keys(hist);

const K = 1.5;
const MAX_CONCURRENT = 2;
const CORR_MAX = 0.65;
const HOLD_MAX_DAYS = 5;
const START = 1000, TARGET = 1120, FLOOR = 970;
const FEE = 0.0026;

function ema(v, p) { const k=2/(p+1); let e=v[0]; const o=[]; for(let i=0;i<v.length;i++){e=i===0?v[0]:v[i]*k+e*(1-k);o.push(e);} return o; }
function atr(bars,p=14){const w=bars.slice(-p-1);if(w.length<p+1)return 0;let s=0;for(let i=1;i<w.length;i++)s+=Math.max(w[i].high-w[i].low,Math.abs(w[i].high-w[i-1].close),Math.abs(w[i].low-w[i-1].close));return s/(w.length-1);}
function pearson(a,b){const n=Math.min(a.length,b.length);if(n<5)return 0;const x=a.slice(-n),y=b.slice(-n);const mx=x.reduce((s,v)=>s+v,0)/n,my=y.reduce((s,v)=>s+v,0)/n;let num=0,dx=0,dy=0;for(let i=0;i<n;i++){num+=(x[i]-mx)*(y[i]-my);dx+=(x[i]-mx)**2;dy+=(y[i]-my)**2;}const den=Math.sqrt(dx*dy);return den===0?0:num/den;}
function riskFor(eq){if(eq<=FLOOR)return 0;if(eq>=TARGET)return 20;if(eq<=1045){return +(7/75*(eq-FLOOR)).toFixed(4);}return +(7+(20-7)/(1120-1045)*(eq-1045)).toFixed(4);}

export function simulate(strategy, blockBars, params = {}) {
  // blockBars: {pair: [bars slice]}
  const Kp = params.K ?? K;
  const MAXC = params.MAX_CONCURRENT ?? MAX_CONCURRENT;
  const CORRM = params.CORR_MAX ?? CORR_MAX;
  const HOLDD = params.HOLD_MAX_DAYS ?? HOLD_MAX_DAYS;
  const RISKSCALE = params.RISKSCALE ?? 1;
  const CAP = params.CAP ?? 75;
  const EXIT = params.EXIT ?? 'fixed';
  const TRAIL = params.TRAIL_ATR ?? 1.0;
  const USE_RSI = params.RSI ?? false;
  const USE_VOL = params.VOL ?? false;
  const USE_GREEN = params.GREEN ?? false;
  const USE_TREND = params.TREND ?? false;
  const MINTP = params.MIN_TP ?? 0;
  const WARMUP = params.WARMUP ?? 0;
  const EMA200F = params.EMA200 ?? false;
  const REGIME = params.REGIME ?? false;
  const STOP_ATR = params.STOP_ATR ?? 1.5;
  const TARGET_ATR = params.TARGET_ATR ?? 3.0;
  const pairs = Object.keys(blockBars);
  const n = blockBars[pairs[0]].length;
  const positions = {}; // pair -> {size, entry, stop, tp, openedIdx}
  let cash = START;
  let wins=0, losses=0, entries=0;
  let worstEq = START, finalEq = START;
  let passed = false, busted = false, passDay = null, bustDay = null;
  const closes = (p, i) => blockBars[p][i].close;

  function equity(i) {
    let e = cash;
    for (const [p,pos] of Object.entries(positions)) e += pos.size * closes(p,i);
    return e;
  }
  function corr(pA, pB, i) {
    const a = blockBars[pA].slice(Math.max(0,i-60), i+1).map(b=>b.close);
    const b = blockBars[pB].slice(Math.max(0,i-60), i+1).map(b=>b.close);
    const ra = a.slice(1).map((v,j)=>(v-a[j])/a[j]);
    const rb = b.slice(1).map((v,j)=>(v-b[j])/b[j]);
    return pearson(ra, rb);
  }

  for (let i = 0; i < n; i++) {
    // manage
    for (const p of Object.keys(positions)) {
      const pos = positions[p];
      const bar = blockBars[p][i];
      const open = Number.isFinite(bar.open) ? bar.open : bar.close;
      if (EXIT === 'trailing') {
        const trailDist = TRAIL * (pos.atr || (pos.entry*0.02));
        const newStop = bar.close - trailDist;
        if (newStop > pos.stop) pos.stop = newStop;
      }
      // intrabar: live TP is a resting limit order, stop is polled software
      let exitPx = null, reason = '';
      if (open <= pos.stop) { exitPx = open; reason = 'stop'; }
      else if (bar.low <= pos.stop) { exitPx = pos.stop; reason = 'stop'; }
      else if (EXIT !== 'trailing' && open >= pos.tp) { exitPx = open; reason = 'target'; }
      else if (EXIT !== 'trailing' && bar.high >= pos.tp) { exitPx = pos.tp; reason = 'target'; }
      else if (i - pos.openedIdx >= HOLDD) { exitPx = bar.close; reason = 'timestop'; }
      if (exitPx !== null) {
        cash += pos.size * exitPx * (1 - FEE);
        const net = pos.size * (exitPx - pos.entry) - (pos.size*pos.entry + pos.size*exitPx)*FEE;
        if (net >= 0) wins++; else losses++;
        delete positions[p];
      }
    }
    // equity check
    const eq = equity(i);
    if (eq < worstEq) worstEq = eq;
    finalEq = eq;
    if (!passed && eq >= TARGET) { passed = true; passDay = i; }
    if (!busted && eq <= FLOOR) { busted = true; bustDay = i; }

    // entry
    if (passed || busted) continue;
    if (i < WARMUP) continue;
    if (REGIME) {
      const bt = blockBars['BTC/USD'];
      if (!bt || i < 200) continue;
      const bc = bt.slice(0, i + 1).map(b => b.close);
      const be = ema(bc, 200);
      if (!(bc.at(-1) > be.at(-1) && be.at(-1) > be[be.length - 21])) continue;
    }
    const held = Object.keys(positions);
    const cands = [];
    for (const p of pairs) {
      if (positions[p]) continue;
      const bars = blockBars[p].slice(0, i+1);
      if (bars.length < 30) continue;
      const closesArr = bars.map(b=>b.close);
      const a = atr(bars.slice(-15), 14);
      if (!(a > 0)) continue;
      const e20 = ema(closesArr, 20).at(-1);
      const price = closesArr.at(-1);
      const extDown = (e20 - price) / a;
      const extUp = (price - e20) / a;
      let sig = null;
      if (strategy === 'dip' && extDown >= Kp) sig = { ext: extDown, dir: 'down' };
      if (strategy === 'breakout' && extUp >= Kp) sig = { ext: extUp, dir: 'up' };
      if (!sig) continue;
      // filters
      const curBar = blockBars[p][i];
      if (USE_GREEN && !(curBar.close > curBar.open)) continue;
      if (USE_VOL) {
        const vols = bars.slice(-20).map(b=>b.volume);
        const avgVol = vols.reduce((s,v)=>s+v,0)/vols.length;
        if (!(curBar.volume > 1.5 * avgVol)) continue;
      }
      if (USE_RSI) {
        // RSI14
        const cc = closesArr.slice(-15);
        let gains=0, losses=0;
        for (let j=1;j<cc.length;j++){ const d=cc[j]-cc[j-1]; if(d>0)gains+=d; else losses-=d; }
        const rs = losses===0 ? 100 : gains/losses;
        const rsi = 100 - 100/(1+rs);
        if (rsi > 35) continue;
      }
      if (USE_TREND) {
        if (closesArr.length < 55) continue;
        const e50 = ema(closesArr, 50);
        if (!(e50.at(-1) > e50.at(-6))) continue;
      }
      if (EMA200F) {
        if (closesArr.length < 200) continue;
        if (!(price > ema(closesArr, 200).at(-1))) continue;
      }
      if (MINTP > 0 && (100 * TARGET_ATR * a / price) < MINTP) continue;   // fee-aware TP filter (live)
      // corr guard
      let blocked = false;
      for (const h of held) {
        if (Math.abs(corr(p, h, i)) > CORRM) { blocked = true; break; }
      }
      if (blocked) continue;
      cands.push({ pair: p, ext: sig.ext, price, atr: a });
    }
    cands.sort((a,b) => b.ext - a.ext);
    let usedOpen = 0;
    for (const p of held) {
      const pos = positions[p];
      usedOpen += Math.abs(pos.entry - pos.stop) * pos.size;
    }
    let allowed = Math.min(riskFor(eq) * RISKSCALE, Math.max(0, CAP - usedOpen));
    for (const c of cands) {
      if (Object.keys(positions).length >= MAXC) break;
      if (allowed <= 0) break;
      const stopDist = STOP_ATR * c.atr;
      const targetDist = TARGET_ATR * c.atr;
      const stopPx = c.price - stopDist;
      const tpPx = c.price + targetDist;
      let size = allowed / stopDist;
      const maxNotional = eq * 0.20;
      if (size * c.price > maxNotional) size = maxNotional / c.price;
      size = Math.floor(size * 1e8) / 1e8;
      if (size <= 0 || size * c.price < 0.5) continue;
      // execute at close
      const cost = size * c.price * (1 + FEE);
      if (cost > cash) continue;
      cash -= cost;
      positions[c.pair] = { size, entry: c.price, stop: stopPx, tp: tpPx, openedIdx: i, atr: c.atr };
      entries++;
      allowed -= Math.abs(c.price - stopPx) * size;
    }
  }
  // close remaining at last price
  for (const p of Object.keys(positions)) {
    const pos = positions[p];
    const price = closes(p, n-1);
    cash += pos.size * price * (1 - FEE);
    const net = pos.size * (price - pos.entry) - (pos.size*pos.entry + pos.size*price)*FEE;
    if (net >= 0) wins++; else losses++;
  }
  const finalEquity = cash;
  return { entries, wins, losses, winRate: entries ? wins/entries : 0, passed, busted, passDay, bustDay, worstEq, finalEquity };
}

if (import.meta.url === `file://${process.argv[1]}`) {
const P = {
  K: +(process.env.K ?? 1.5),
  RSI: process.env.RSI === '1',
  GREEN: process.env.GREEN === '1',
  TREND: process.env.TREND === '1',
  RISKSCALE: +(process.env.RISKSCALE ?? 1),
  MIN_TP: +(process.env.MIN_TP ?? 0),
  STOP_ATR: +(process.env.STOP_ATR ?? 1.5),
  TARGET_ATR: +(process.env.TARGET_ATR ?? 3.0),
  HOLD_MAX_DAYS: +(process.env.HOLD ?? 5),
  EMA200: process.env.EMA200 === '1',
  REGIME: process.env.REGIME === '1',
  EXIT: process.env.EXIT ?? 'fixed',
};
console.log('params:', JSON.stringify(P));
// blocks: 4 blocks of ~180 days
const N = hist[UNIVERSE[0]].length;
const BLOCK = 180;
const WARMUPC = 200;
const numBlocks = Math.floor(N / BLOCK);
console.log(`N=${N} days, blocks=${numBlocks} of ${BLOCK} days`);

for (const strategy of ['dip', 'breakout']) {
  console.log(`\n===== STRATEGY: ${strategy} =====`);
  let passCount = 0, bustCount = 0, totalEntries = 0, worstOverall = START;
  const passDays = [];
  for (let b = 0; b < numBlocks; b++) {
    const start = b * BLOCK;
    const end = start + BLOCK;
    const from = Math.max(0, start - WARMUPC);
    const blockBars = {};
    for (const p of UNIVERSE) blockBars[p] = hist[p].slice(from, end);
    const r = simulate(strategy, blockBars, { ...P, WARMUP: start - from });
    passCount += r.passed ? 1 : 0;
    bustCount += r.busted ? 1 : 0;
    totalEntries += r.entries;
    if (r.worstEq < worstOverall) worstOverall = r.worstEq;
    if (r.passed) passDays.push(r.passDay);
    console.log(`block ${b+1} (days ${start}-${end}): entries=${r.entries} wins=${r.wins} win%=${(r.winRate*100).toFixed(1)} final=$${r.finalEquity.toFixed(0)} worst=$${r.worstEq.toFixed(0)} ${r.passed?'PASS day '+r.passDay:''}${r.busted?'BUST day '+r.bustDay:''}`);
  }
  const medPass = passDays.length ? passDays.sort((a,b)=>a-b)[Math.floor(passDays.length/2)] : null;
  console.log(`AGGREGATE: PASS ${passCount}/${numBlocks}  BUST ${bustCount}/${numBlocks}  entries ${totalEntries}  worstEq $${worstOverall.toFixed(0)}  median pass day ${medPass}`);
}
}
