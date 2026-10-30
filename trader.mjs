#!/usr/bin/env node
/**
 * One trading cycle for Kraken Spot Paper.
 * Modes: `node trader.mjs loop` (manage + entry) | `node trader.mjs loop noentry`
 */
import { status, equity, verdict, loadState, saveState, RULES, ticker, ohlc, lastPrice, paperOrders } from './ctl.mjs';
import { buy, sell, limitSell, cancel, cancelAll } from './spot.mjs';
import { riskFor, budgetFor } from './riskpolicy.mjs';
import { appendFileSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const KRAKEN_CLI = '/home/oc/bin/kraken';

const DIR = '/home/oc/kraken-spot';
const LOG = `${DIR}/bot.log`;
const ALERTS = `${DIR}/alerts.log`;
const TRADES = `${DIR}/trades.jsonl`;
const CACHE_FILE = `${DIR}/ohlc.1d.cache.json`;
const DAY_MS = 86_400_000;

// ---- parameters (validate via sweep before changing) ----------------------
const K = 1.25;                // entry threshold in ATR units (sweep 2026-10-25: best pass/bust)
const MIN_TARGET_PCT = 1.6;    // TP must clear ~3x round-trip fees (0.52%) or the trade can't pay
const MAX_CONCURRENT = 2;      // start conservative
const CORR_MAX = 0.65;         // skip if corr with a held position exceeds this
const HOLD_MAX_DAYS = 10;
const STOP_ATR = 1.5;
const TARGET_ATR = 0.75;
const MIN_BARS = 220;           // EMA200 + 20 bars for its slope
const PROTECT = process.env.FBOT_PROTECT || 'off';
const ENTRY_ENABLED_DEFAULT = true;
const REPORT_EVERY = 5;
const FREEZE_FILE = `${DIR}/FROZEN`;
const FREEZE_MIN_TRADES = 15;   // qoder 2026-10-28: needs a real sample before halting
const FREEZE_WINRATE = 0.55;

const UNIVERSE = ['BTC/USD','ETH/USD','SOL/USD','XRP/USD','ADA/USD','DOGE/USD','LINK/USD','AVAX/USD','DOT/USD','LTC/USD','BCH/USD','UNI/USD','ATOM/USD','NEAR/USD','APT/USD','ARB/USD','OP/USD','SUI/USD','INJ/USD','TIA/USD','TRX/USD','XLM/USD','ETC/USD','FIL/USD'];

function logLine(msg) { appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); }
function alert(msg) {
  const line = `${new Date().toISOString()} [ALERT] ${msg}`;
  appendFileSync(ALERTS, line + '\n');
  console.log(line);
}

// ---- math helpers ---------------------------------------------------------
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let e = values[0];
  for (let i = 0; i < values.length; i++) {
    e = i === 0 ? values[0] : values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}
function atr(bars, period = 14) {
  const w = bars.slice(-period - 1);
  if (w.length < period + 1) return 0;
  let s = 0;
  for (let i = 1; i < w.length; i++) {
    s += Math.max(w[i].high - w[i].low,
      Math.abs(w[i].high - w[i-1].close),
      Math.abs(w[i].low - w[i-1].close));
  }
  return s / (w.length - 1);
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s,v)=>s+v,0)/n;
  const my = y.reduce((s,v)=>s+v,0)/n;
  let num=0, dx=0, dy=0;
  for (let i=0;i<n;i++){ num += (x[i]-mx)*(y[i]-my); dx += (x[i]-mx)**2; dy += (y[i]-my)**2; }
  const den = Math.sqrt(dx*dy);
  return den === 0 ? 0 : num/den;
}

// ---- correlation cache ----------------------------------------------------
const corrCache = new Map();
function closesFor(pair) {
  try { return dailyBars(pair).map(b => b.close); } catch { return []; }
}
export function corrWith(pairA, pairB) {
  const key = [pairA, pairB].sort().join('|');
  if (corrCache.has(key)) return corrCache.get(key);
  const a = closesFor(pairA), b = closesFor(pairB);
  // use returns
  const ra = a.slice(1).map((v,i)=> (v-a[i])/a[i]);
  const rb = b.slice(1).map((v,i)=> (v-b[i])/b[i]);
  const c = pearson(ra, rb);
  corrCache.set(key, c);
  return c;
}

// ---- market regime (qoder 2026-10-28) -------------------------------------
export function marketRegime() {
  if (globalThis.__TEST_MARKET__) return globalThis.__TEST_MARKET__;
  let bars;
  try { bars = dailyBars('BTC/USD'); }
  catch { return { ok: false, reason: 'network' }; }
  if (bars.length < MIN_BARS) return { ok: false, reason: 'insufficient_bars' };
  const closes = bars.map(b => b.close);
  const e200 = ema(closes, 200);
  const close = closes.at(-1);
  const now = e200.at(-1);
  const then = e200[e200.length - 21];
  const rising = now > then;
  return { ok: close > now && rising, close, ema200: now, rising };
}

// ---- daily candles with on-disk cache --------------------------------------
// The last *completed* daily candle only changes at 00:00 UTC, so caching it is
// safe: signals are deterministic intraday. A failed fetch falls back to stale.
let barsCache = null, cacheDirty = false;
function loadBarsCache() {
  if (barsCache) return barsCache;
  try { barsCache = JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { barsCache = {}; }
  return barsCache;
}
function flushBarsCache() {
  if (!cacheDirty || !barsCache) return;
  try { writeFileSync(CACHE_FILE, JSON.stringify(barsCache)); } catch { /* ignore */ }
}
process.on('exit', flushBarsCache);

function dailyBars(pair) {
  if (process.env.KS_NO_CACHE === '1') return fetchBars(pair);
  const now = Date.now();
  const cache = loadBarsCache();
  const entry = cache[pair];
  // signals are deterministic within a UTC day: one refresh per day is enough
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  if (entry?.bars?.length && entry.ts >= todayStart) return entry.bars;
  try {
    const bars = fetchBars(pair);
    if (bars.length) { cache[pair] = { ts: now, bars }; cacheDirty = true; return bars; }
  } catch (err) {
    if (entry?.bars?.length) return entry.bars;   // stale cache beats no signal
    throw err;
  }
  return entry?.bars ?? [];
}

function fetchBars(pair) {
  const r = ohlc(pair, 1440);
  const raw = (r.candles ?? r.ohlc ?? []).filter(c => Number(c.time) < Number(r.last));
  return raw.map(c => ({ time:+c.time, open:+c.open, high:+c.high, low:+c.low, close:+c.close }));
}

function parseCli(out) {
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  for (const c of [...lines].reverse()) {
    if (!c.startsWith('{') && !c.startsWith('[')) continue;
    try { return JSON.parse(c); } catch { /* keep looking */ }
  }
  throw new Error('no JSON in response');
}

async function fetchBarsAsync(pair) {
  const { stdout } = await execFileP(KRAKEN_CLI, ['ohlc', pair, '--interval', '1440', '-o', 'json'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
  return parseBarsStdout(stdout);
}
function parseBarsStdout(stdout) {
  const r = parseCli(stdout);
  const raw = (r.candles ?? r.ohlc ?? []).filter(c => Number(c.time) < Number(r.last));
  return raw.map(c => ({ time:+c.time, open:+c.open, high:+c.high, low:+c.low, close:+c.close }));
}

// Cold start: one daily refresh, fetched with bounded concurrency.
export async function prewarm(concurrency = 5) {
  if (process.env.KS_NO_CACHE === '1') return { fetched: 0, skipped: true };
  const now = Date.now();
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const cache = loadBarsCache();
  const todo = [...new Set([...UNIVERSE, 'BTC/USD'])].filter(p => {
    const e = cache[p];
    return !(e?.bars?.length && e.ts >= todayStart);
  });
  let fetched = 0, failed = 0;
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const pair = queue.shift();
      try {
        const bars = await fetchBarsAsync(pair);
        if (bars.length) { cache[pair] = { ts: now, bars }; cacheDirty = true; fetched++; }
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  flushBarsCache();
  return { fetched, failed, total: todo.length };
}

// ---- signal ---------------------------------------------------------------
export function analyse(pair) {
  // test hook
  let bars;
  if (globalThis.__TEST_BARS__ && globalThis.__TEST_BARS__[pair]) {
    bars = globalThis.__TEST_BARS__[pair];
  } else {
    bars = dailyBars(pair); // daily bars — matches the 2026-10-25 sweep geometry
  }
  if (bars.length < MIN_BARS) return null;
  const closes = bars.map(b => b.close);
  const a = atr(bars, 14);
  if (!(a > 0)) return null;
  const e20 = ema(closes, 20).at(-1);
  const e200 = ema(closes, 200).at(-1);
  const price = closes.at(-1);
  if (!(price > e200)) return null;    // pair must be in an uptrend (qoder 2026-10-28)
  // spot long: buy the dip (price stretched below EMA)
  const extDown = (e20 - price) / a;   // positive when price below EMA
  const extUp = (price - e20) / a;     // positive when price above EMA
  // candidate long on oversold dip
  if (extDown < K) return null;
  const stopDist = STOP_ATR * a;
  const targetDist = TARGET_ATR * a;         // high win-rate target (sweep 2026-10-28)
  const stopPx = price - stopDist;
  const tpPx = price + targetDist;
  return {
    side: 'long',
    pair,
    price,
    ext: extDown,
    stopPx,
    tpPx,
    atr: a,
    stopPct: (stopDist / price) * 100,
    targetPct: (targetDist / price) * 100,
  };
}

// ---- manage ---------------------------------------------------------------
function reportStats() {
  if (!existsSync(TRADES)) return;
  const lines = readFileSync(TRADES, 'utf8').trim().split('\n').filter(Boolean);
  const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (recs.length === 0) return;
  const wins = recs.filter(r => r.net >= 0);
  const losses = recs.filter(r => r.net < 0);
  const totalNet = recs.reduce((s, r) => s + r.net, 0);
  const grossWin = wins.reduce((s, r) => s + r.net, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.net, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  // cumulative drawdown
  let cum = 0, peak = 0, maxDD = 0;
  for (const r of recs) { cum += r.net; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDD) maxDD = dd; }
  const msg = `STATS trades=${recs.length} wins=${wins.length} losses=${losses.length} win%=${(wins.length/recs.length*100).toFixed(1)} totalNet=${totalNet.toFixed(2)} avgWin=${wins.length? (grossWin/wins.length).toFixed(2):0} avgLoss=${losses.length? (grossLoss/losses.length).toFixed(2):0} PF=${Number.isFinite(pf)?pf.toFixed(2):'inf'} maxDD=${maxDD.toFixed(2)}`;
  logLine(msg);
  alert(msg);
}

function closePosition(state, sym, pos, price, reason) {
  const size = pos.size;
  // free reserved balance: cancel TP resting (and any stale orders on the symbol)
  if (pos.tpOrderId) { try { cancel(pos.tpOrderId); } catch {} }
  try { /* cancel any remaining orders on this symbol */ } catch {}
  // small delay to let the cancel settle in the journal
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  sleepSync(800);
  // if balance still reserved, cancel-all as a last resort
  let r;
  try { r = sell(sym, size); }
  catch (e) {
    try { cancelAll(); sleepSync(800); } catch {}
    r = sell(sym, size);
  }
  const exitPx = r.price || price;
  const fees = (pos.entry * size * 0.0026) + (exitPx * size * 0.0026);
  const gross = (exitPx - pos.entry) * size;
  const net = gross - fees;
  // record trade
  const seq = ++state.tradeSeq;
  const rec = { seq, ts: new Date().toISOString(), symbol: sym, side: 'long',
    entry: pos.entry, exit: exitPx, size, gross: +gross.toFixed(6),
    fees: +fees.toFixed(6), net: +net.toFixed(6), reason, openedAt: pos.openedAt };
  appendFileSync(TRADES, JSON.stringify(rec) + '\n');
  alert(`${sym} ${net >= 0 ? 'WIN' : 'LOSS'} net=${net.toFixed(4)} reason=${reason} seq=${seq}`);
  if (seq % REPORT_EVERY === 0) reportStats();
  delete state.positions[sym];
  return rec;
}

function manage(state) {
  const closed = [];
  const now = Date.now();
  for (const [sym, pos] of Object.entries(state.positions)) {
    let price;
    try { price = lastPrice(sym); } catch { continue; }
    // stop
    if (price <= pos.stopPx) {
      const rec = closePosition(state, sym, pos, price, 'stop');
      closed.push(`${sym} stop ${rec.net}`);
      continue;
    }
    // target
    if (price >= pos.tpPx) {
      const rec = closePosition(state, sym, pos, price, 'target');
      closed.push(`${sym} target ${rec.net}`);
      continue;
    }
    // time stop
    const ageDays = (now - new Date(pos.openedAt).getTime()) / 86400000;
    if (ageDays >= HOLD_MAX_DAYS && price < pos.tpPx) {
      const rec = closePosition(state, sym, pos, price, 'timestop');
      closed.push(`${sym} timestop ${rec.net}`);
      continue;
    }
    // protection: move stop to break-even (fees covered) once price has run enough
    if (PROTECT !== 'off' && price > pos.entry) {
      const feeCostPerUnit = pos.entry * 0.0026 * 2;
      if (price - pos.entry >= feeCostPerUnit) {
        pos.stopPx = Math.max(pos.stopPx, pos.entry + feeCostPerUnit);
      }
    }
  }
  sweepStaleImpl(state);
  return closed;
}

function sweepStaleImpl(state) {
  let oo;
  try { oo = paperOrders(); } catch { return; }
  const orders = oo?.open_orders ?? oo?.orders ?? [];
  const norm = (p) => String(p ?? '').replace('/', '');
  const held = new Set(Object.keys(state.positions).map(norm));
  const tracked = new Set(Object.values(state.positions).map(p => p.tpOrderId).filter(Boolean));
  for (const o of orders) {
    const id = o.order_id ?? o.id;
    if (!id || tracked.has(id)) continue;          // never cancel a live take-profit
    if (!held.has(norm(o.pair ?? o.symbol))) {
      try { cancel(id); } catch {}
    }
  }
}

// sweepStale alias
const sweepStale = sweepStaleImpl;

// ---- entry ----------------------------------------------------------------
function blockedByCorr(pair, heldSymbols) {
  for (const h of heldSymbols) {
    if (Math.abs(corrWith(pair, h)) > CORR_MAX) return h;
  }
  return null;
}

function freezeTripped() {
  const clear = () => { try { unlinkSync(FREEZE_FILE); } catch { /* none */ } };
  if (!existsSync(TRADES)) { clear(); return false; }
  const recs = readFileSync(TRADES, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (recs.length <= FREEZE_MIN_TRADES) { clear(); return false; }
  const wins = recs.filter(r => r.net >= 0).length;
  const winRate = wins / recs.length;
  if (winRate >= FREEZE_WINRATE) { clear(); return false; }
  writeFileSync(FREEZE_FILE, `${new Date().toISOString()} winRate=${(winRate*100).toFixed(1)}% over ${recs.length} trades\n`);
  alert(`FREEZE: win rate ${(winRate*100).toFixed(1)}% < ${FREEZE_WINRATE*100}% over ${recs.length} trades — entries halted`);
  return true;
}

function entry(state, mode, dryRun = false) {
  const entered = [];
  if (mode === 'noentry') return { entered, near: [] };
  // freeze check: derived from the ledger, auto-clears when the win rate recovers
  if (freezeTripped()) return { entered, near: [], frozen: true };
  let g;
  try { g = equity(); } catch { return { entered, near: [] }; }
  const cur = g.cur;
  const v = verdict(cur);
  if (v !== 'RUNNING') return { entered, near: [] };
  let market;
  try { market = marketRegime(); } catch { market = { ok: false }; }
  if (!market.ok) return { entered, near: [], market: { ok: false, reason: market.reason } };
  const b = budgetFor(cur, state);
  let allowed = b.allowed;
  const heldSymbols = Object.keys(state.positions);
  // gather candidates
  const cands = [];
  for (const pair of UNIVERSE) {
    if (state.positions[pair]) continue;
    let sig;
    try { sig = analyse(pair); } catch { continue; }
    if (!sig) continue;
    if (!(sig.targetPct >= MIN_TARGET_PCT)) continue;   // fees would eat the edge
    const blocker = blockedByCorr(pair, heldSymbols);
    if (blocker) continue;
    cands.push(sig);
  }
  cands.sort((a, b) => b.ext - a.ext);
  const near = cands.slice(0, 5).map(c => `${c.pair}:${c.ext.toFixed(2)}`);
  for (const sig of cands) {
    if (Object.keys(state.positions).length >= MAX_CONCURRENT) break;
    if (allowed <= 0) break;
    const stopDist = sig.price - sig.stopPx;
    if (stopDist <= 0) continue;
    let size = allowed / stopDist;
    // notional cap
    const maxNotional = cur * 0.20;
    if (size * sig.price > maxNotional) size = maxNotional / sig.price;
    size = Math.floor(size * 1e8) / 1e8;
    if (size <= 0) continue;
    // min order size
    if (size * sig.price < 0.5) continue;
    if (dryRun) {
      entered.push(`dry ${sig.pair} ext=${sig.ext.toFixed(2)} size=${size}`);
      allowed = Math.max(0, allowed - (Math.abs(sig.price - sig.stopPx) * size));
      continue;
    }
    try {
      const r = buy(sig.pair, size);
      const entryPx = r.price || sig.price;
      const filled = Number(r.size) || size;
      // re-anchor stop/target to the real fill price (qoder 2026-10-28)
      const stopPx = entryPx - STOP_ATR * sig.atr;
      const tpPx = entryPx + TARGET_ATR * sig.atr;
      state.positions[sig.pair] = {
        side: 'long', size: filled, entry: entryPx, stopPx, tpPx,
        atr: sig.atr, ext: sig.ext,
        openedAt: new Date().toISOString(), entryOrderId: r.orderId, tpOrderId: null,
      };
      // place TP resting
      try {
        const tp = limitSell(sig.pair, filled, tpPx);
        state.positions[sig.pair].tpOrderId = tp?.order_id ?? tp?.id ?? null;
      } catch {}
      allowed = Math.max(0, allowed - (Math.abs(entryPx - stopPx) * filled));
      entered.push(`${sig.pair} ext=${sig.ext.toFixed(2)}`);
    } catch (e) {
      logLine(`entry failed ${sig.pair}: ${e.message}`);
    }
  }
  return { entered, near };
}

// ---- main -----------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('unfreeze')) {
    try { (await import('node:fs')).unlinkSync(FREEZE_FILE); } catch {}
    console.log(JSON.stringify({ unfrozen: true }));
    return;
  }
  if (args.includes('freeze-status')) {
    console.log(JSON.stringify({ frozen: existsSync(FREEZE_FILE), file: FREEZE_FILE }));
    return;
  }
  const mode = args.includes('noentry') ? 'noentry' : 'auto';
  const noEntry = mode === 'noentry';
const dryRun = args.includes('--dry-run');
  try {
    const pw = await prewarm();
    if (pw.fetched || pw.failed) logLine(`prewarm: refreshed=${pw.fetched} failed=${pw.failed} of ${pw.total}`);
  } catch (e) { logLine(`prewarm failed: ${e.message}`); }
  const state = loadState();
  let g;
  try { g = equity(); } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
  state.status = verdict(g.cur);
  // manage
  const closed = manage(state);
  // sweep (already inside manage)
  // sweepStaleImpl(state);
  // entry
  const er = entry(state, noEntry ? 'noentry' : 'auto', dryRun);
  const entered = er.entered ?? [];
  const near = er.near;
  // flatten on terminal verdict
  const v = verdict(g.cur);
  if (v !== 'RUNNING') {
    for (const sym of Object.keys(state.positions)) {
      const pos = state.positions[sym];
      try {
        const price = lastPrice(sym);
        closePosition(state, sym, pos, price, v.toLowerCase());
      } catch (e) { logLine(`flatten failed ${sym}: ${e.message}`); }
    }
  }
  // save state
  saveState(state);
  // summary
  const summary = {
    positions: Object.keys(state.positions).length,
    closed,
    entered,
    near,
    blocked: [],
  };
  console.log(JSON.stringify(summary));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.log(JSON.stringify({ error: e.stack || e.message }));
    process.exit(1);
  });
}
