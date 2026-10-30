#!/usr/bin/env node
/**
 * Kraken Spot Paper — controller.
 *
 * Rules (mirrors the challenge semantics for comparability):
 *   start equity      $1000
 *   profit target     +12%  -> $1120  = PASS
 *   loss floor         -3%  -> $970   = GAME OVER (static, from start balance)
 *   no daily limit, no time limit
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';

const KRAKEN = '/home/oc/bin/kraken';
const WS = 'spotbot';
export const DIR = '/home/oc/kraken-spot';
export const STATE = `${DIR}/state.json`;
export const EQUITY_CSV = `${DIR}/equity.csv`;
export const TRADES = `${DIR}/trades.jsonl`;

export const RULES = {
  start: 1000,
  targetPct: 12,
  floorPct: 3,
  get target() { return this.start * (1 + this.targetPct / 100); },
  get floor() { return this.start * (1 - this.floorPct / 100); },
};

export const RISK = {
  feePerSide: 0.0026,   // spot paper taker fee, 0.26%
  perTradeRiskPct: 0.0030,
  maxPosPct: 0.20,
  maxTotalPct: 0.40,
  minRR: 2.0,
};

function parseResult(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const candidates = [...lines].reverse();
  for (const c of candidates) {
    if (!c.startsWith('{') && !c.startsWith('[')) continue;
    try { return JSON.parse(c); } catch { /* keep looking */ }
  }
  throw new Error(`no JSON in response: ${out.slice(0, 200)}`);
}

const LOCK_MSG = 'in use by another process';
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function kraken(args, { allowFail = false, retries = 8 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) sleepSync(400 + attempt * 350);
    try {
      const out = execFileSync(KRAKEN, ['--workspace', WS, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
      if (!out.trim()) throw new Error('empty response');
      return parseResult(out);
    } catch (err) {
      const msg = (err.stderr || err.stdout || err.message || '').toString().trim();
      if (msg.includes(LOCK_MSG)) { lastErr = msg; continue; }
      if (allowFail) return null;
      throw new Error(`kraken ${args.join(' ')} -> ${msg.slice(0, 400)}`);
    }
  }
  if (allowFail) return null;
  throw new Error(`kraken ${args.join(' ')} -> lock still held after ${retries + 1} tries: ${lastErr?.slice(0, 200)}`);
}

// spot paper
export const status = () => kraken(['paper', 'status', '-o', 'json']);
export const balance = () => kraken(['paper', 'balance', '-o', 'json'], { allowFail: true });
export const paperOrders = () => kraken(['paper', 'orders', '-o', 'json'], { allowFail: true });
export const paperHistory = () => kraken(['paper', 'history', '-o', 'json'], { allowFail: true });
// market data (global, no workspace needed but harmless)
export const ticker = (pair) => {
  // use global kraken without workspace override for ticker
  try {
    const out = execFileSync(KRAKEN, ['ticker', pair, '-o', 'json'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], maxBuffer: 32*1024*1024 });
    return parseResult(out);
  } catch (e) {
    throw new Error(`ticker ${pair}: ${(e.stderr||e.message||'').toString().slice(0,200)}`);
  }
};
export const ohlc = (pair, interval = 60) => {
  const out = execFileSync(KRAKEN, ['ohlc', pair, '--interval', String(interval), '-o', 'json'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], maxBuffer: 32*1024*1024 });
  return parseResult(out);
};

export function loadState() {
  if (!existsSync(STATE)) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(STATE, JSON.stringify({
      createdAt: new Date().toISOString(),
      status: 'RUNNING',
      peak: RULES.start,
      trough: RULES.start,
      positions: {},
      tradeSeq: 0,
      seenFills: [],
      lastEquity: RULES.start,
    }, null, 2));
  }
  return JSON.parse(readFileSync(STATE, 'utf8'));
}
export function saveState(s) { writeFileSync(STATE, JSON.stringify(s, null, 2)); }

export function equity() {
  const read = () => {
    const s = status();
    return { st: s, v: Number(s.current_value ?? s.equity) };
  };
  let { st, v } = read();
  if (!Number.isFinite(v)) throw new Error('bad equity');
  // anti-glitch: a jump >5% vs last snapshot is only accepted if a second read confirms it
  let prev = null;
  try { prev = Number(JSON.parse(readFileSync(STATE, 'utf8')).lastEquity); } catch { /* first run */ }
  if (Number.isFinite(prev) && prev > 0 && Math.abs(v / prev - 1) > 0.05) {
    const s2 = read();
    if (Number.isFinite(s2.v)) {
      if (Math.abs(s2.v / prev - 1) <= 0.05) { st = s2.st; v = s2.v; }
      else if (Math.abs(s2.v / v - 1) <= 0.01) { v = (v + s2.v) / 2; st = s2.st; }
      else {
        const s3 = read();
        const vals = [v, s2.v, s3.v].filter(Number.isFinite).sort((a, b) => a - b);
        v = vals[Math.floor(vals.length / 2)];
        st = s3.st;
      }
    }
  }
  if (!Number.isFinite(v)) throw new Error('bad equity');
  return { cur: v, st };
}

export function verdict(cur) {
  if (cur >= RULES.target) return 'PASS';
  if (cur <= RULES.floor) return 'BUST';
  return 'RUNNING';
}

export function snapshot(note = '') {
  const { cur, st } = equity();
  const s = loadState();
  s.peak = Math.max(s.peak, cur);
  s.trough = Math.min(s.trough, cur);
  s.lastEquity = cur;
  s.status = verdict(cur);
  saveState(s);

  if (!existsSync(EQUITY_CSV)) {
    appendFileSync(EQUITY_CSV, 'ts,equity,pnl_pct,progress_to_target,unrealized,note\n');
  }
  const unreal = Object.keys(loadState().positions ?? {}).length === 0 ? 0 : Number(st.unrealized_pnl ?? 0);
  const pnl = ((cur - RULES.start) / RULES.start) * 100;
  const progress = ((cur - RULES.start) / (RULES.target - RULES.start)) * 100;
  appendFileSync(EQUITY_CSV,
    `${new Date().toISOString()},${cur.toFixed(2)},${pnl.toFixed(3)},${progress.toFixed(2)},${unreal.toFixed(2)},"${note.replace(/"/g, "'")}"\n`);
  return { cur, pnl, progress, status: s.status };
}

export function guard() {
  const { cur } = equity();
  const v = verdict(cur);
  return { equity: cur, verdict: v, target: RULES.target, floor: RULES.floor };
}

export const round = (n, d) => Math.floor(n * 10 ** d) / 10 ** d;

export function sizeFor(pair, price, stopPct, equityUsd, notionalPct = RISK.maxPosPct, riskPct = RISK.perTradeRiskPct) {
  const riskUsd = equityUsd * riskPct;
  const stopDist = price * (stopPct / 100);
  let vol = riskUsd / stopDist;
  const maxNotional = equityUsd * notionalPct;
  if (vol * price > maxNotional) vol = maxNotional / price;

  const lotDecimals = 8;
  vol = round(vol, lotDecimals);
  const orderMin = { 'BTC/USD': 0.00005, 'ETH/USD': 0.001, 'SOL/USD': 0.06 }[pair] ?? 0.0001;
  const costMin = 0.5;
  if (vol < orderMin) vol = orderMin;
  let notional = vol * price;
  if (notional < costMin) {
    vol = round(costMin / price, lotDecimals);
    if (vol < orderMin) vol = orderMin;
    notional = vol * price;
  }
  const effStopPct = Math.min(stopPct, (riskUsd / notional) * 100);
  const effRisk = notional * (effStopPct / 100);
  return { vol, notional, riskUsd: effRisk, budgetedRisk: riskUsd, capped: notional < riskUsd / (stopPct / 100) - 1e-9 };
}

export function rrAfterFees(stopPct, targetPct) {
  const feeCostPct = 2 * RISK.feePerSide * 100; // 0.52%
  const netWin = targetPct - feeCostPct;
  const netLoss = stopPct + feeCostPct;
  return { netWin, netLoss, rr: netWin / netLoss };
}

export function lastPrice(pair) {
  const t = ticker(pair);
  // ticker may return object keyed by pair or array
  let v;
  if (Array.isArray(t)) v = t[0];
  else if (t && t[pair]) v = t[pair];
  else v = t;
  const px = Number(v?.last_price ?? v?.last ?? v?.ask_price ?? v?.bid_price ?? v?.price);
  if (!Number.isFinite(px) || px <= 0) throw new Error(`bad ticker for ${pair}: ${JSON.stringify(t).slice(0,200)}`);
  return px;
}

const f = (n, d = 2) => Number(n).toFixed(d);

export function report() {
  const { cur, st } = equity();
  const s = loadState();
  const v = verdict(cur);
  const pnl = ((cur - RULES.start) / RULES.start) * 100;
  const progress = ((cur - RULES.start) / (RULES.target - RULES.start)) * 100;
  const distFloor = ((cur - RULES.floor) / RULES.start) * 100;
  const distTarget = ((RULES.target - cur) / RULES.start) * 100;
  const bal = balance();
  const open = paperOrders() ?? {};
  const openOrders = open.open_orders ?? open.orders ?? [];

  const bar = (pct, w = 26) => {
    const n = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
    return '█'.repeat(n) + '░'.repeat(w - n);
  };

  const lines = [
    `┌──────────────── KRAKEN SPOT PAPER ────────────────┐`,
    `│ status   ${v.padEnd(10)} ${v === 'PASS' ? '🎉 TARGET REACHED' : v === 'BUST' ? '💀 FLOOR BREACHED' : 'in play'}  `.padEnd(56) + `│`,
    `│ equity   $${f(cur)}   start $${f(RULES.start)}   P&L ${pnl >= 0 ? '+' : ''}${f(pnl)}%  `.padEnd(56) + `│`,
    `│ target   $${f(RULES.target)} (+12%)   floor $${f(RULES.floor)} (-3%)  `.padEnd(56) + `│`,
    `│ progress ${bar(progress)} ${f(progress, 1)}%  `.padEnd(56) + `│`,
    `│ runway   ${f(distTarget)}% to PASS  |  ${f(distFloor)}% to BUST  `.padEnd(56) + `│`,
    `│ peak     $${f(s.peak)}   trough $${f(s.trough)}   unrealized ${f(Object.keys(s.positions ?? {}).length === 0 ? 0 : Number(st.unrealized_pnl ?? 0))}  `.padEnd(56) + `│`,
    `│ cash     $${f(Number(bal?.balances?.USD?.available ?? bal?.available ?? 0))}   positions ${Object.keys(s.positions).length}   openOrders ${openOrders.length}  `.padEnd(56) + `│`,
    `└──────────────────────────────────────────────────┘`,
  ];
  return { text: lines.join('\n'), cur, verdict: v, progress, pnl, state: s };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'status' || !cmd) {
      const r = report();
      console.log(r.text);
    } else if (cmd === 'json') {
      const r = report();
      console.log(JSON.stringify({ equity: r.cur, verdict: r.verdict, progress: r.progress, pnl: r.pnl, state: r.state }));
    } else if (cmd === 'snapshot') {
      const note = rest.join(' ');
      const r = snapshot(note);
      console.log(JSON.stringify(r));
    } else if (cmd === 'guard') {
      const g = guard();
      console.log(JSON.stringify(g));
      if (g.verdict === 'BUST') process.exitCode = 2;
    } else if (cmd === 'size') {
      const [pair, stopPct] = rest;
      const { cur } = equity();
      const px = lastPrice(pair);
      const s = sizeFor(pair, px, Number(stopPct), cur);
      console.log(JSON.stringify({ pair, price: px, ...s, rr: rrAfterFees(Number(stopPct), Number(rest[2] ?? 4)) }));
    } else {
      console.error(`unknown command: ${cmd}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}
