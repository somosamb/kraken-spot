#!/usr/bin/env node
/**
 * One trading cycle for Kraken Spot Paper.
 * Modes: `node trader.mjs loop` (reconcile + manage + entry) | `node trader.mjs loop noentry`
 *
 * Crash-safety contract: every exchange mutation (buy, sell, TP placement) is followed by
 * an immediate saveState(), and every cycle starts by reconciling state.json against the
 * real balances, so a cycle killed at any point can never leave an untracked position or
 * cause a duplicate buy.
 */
import {
  DIR, KRAKEN, equity, verdict, confirmedVerdict, loadState, saveState, ohlc, lastPrice,
  lastPrices, paperOrders, paperHistory, balance, holdingsFrom, FEE_PER_SIDE, DUST_USD, HALTED,
} from './ctl.mjs';
import { buy, sell, limitSell, cancel, cancelPair } from './spot.mjs';
import { budgetFor } from './riskpolicy.mjs';
import { appendFileSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const LOG = `${DIR}/bot.log`;
const ALERTS = `${DIR}/alerts.log`;
const TRADES = `${DIR}/trades.jsonl`;
const CACHE_FILE = `${DIR}/ohlc.1d.cache.json`;
const DAY_MS = 86_400_000;

// ---- parameters (validate via sweep before changing) ----------------------
const K = 1.25;                // entry threshold in ATR units (sweep 2026-10-25: best pass/bust)
const MIN_TARGET_PCT = 1.6;    // TP must clear ~3x round-trip fees (0.52%); implied by MIN_ATR_PCT, kept as a guard
const MIN_ATR_PCT = 3;         // volatility floor: low-ATR pairs get oversized positions and lost money (TRX, research 2026-10-31)
const MAX_CONCURRENT = 3;
const CORR_MAX = 0.65;         // skip if corr with a held position exceeds this
const CORR_WINDOW = 60;        // daily returns used for the correlation guard (recent, not all history)
const HOLD_MAX_DAYS = 10;
const STOP_ATR = 1.5;
const TARGET_ATR = 0.75;
const PRICE_DRIFT_ATR = 0.5;   // skip an entry if the live price moved more than this from the signal close
const MIN_BARS = 220;           // EMA200 + 20 bars for its slope
const MAX_NOTIONAL_PCT = 0.35;  // per-position notional cap (fraction of equity)
const MIN_ORDER_USD = 0.5;
const PROTECT = process.env.FBOT_PROTECT || 'off';
const REPORT_EVERY = 5;
const FREEZE_FILE = `${DIR}/FROZEN`;
const FREEZE_MIN_TRADES = 15;   // needs a real sample before halting
const FREEZE_WINRATE = 0.55;

const UNIVERSE = ['BTC/USD','ETH/USD','SOL/USD','XRP/USD','ADA/USD','DOGE/USD','LINK/USD','AVAX/USD','DOT/USD','LTC/USD','BCH/USD','UNI/USD','ATOM/USD','NEAR/USD','APT/USD','ARB/USD','OP/USD','SUI/USD','INJ/USD','TIA/USD','TRX/USD','XLM/USD','ETC/USD','FIL/USD'];

function logLine(msg) { appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); }
function alert(msg) {
  const line = `${new Date().toISOString()} [ALERT] ${msg}`;
  appendFileSync(ALERTS, line + '\n');
  logLine(`[ALERT] ${msg}`);
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const norm = (p) => String(p ?? '').replace('/', '');
const floor8 = (n) => Math.floor(n * 1e8) / 1e8;

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
  if (globalThis.__TEST_BARS__?.[pair]) return globalThis.__TEST_BARS__[pair];
  if (process.env.KS_NO_CACHE === '1') return fetchBars(pair);
  const now = Date.now();
  const cache = loadBarsCache();
  const entry = cache[pair];
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

/**
 * Completed daily candles only. A candle is complete once its 24h are over.
 * (Do not filter on `r.last`: Kraken's `last` is the open time of the last *completed*
 * candle, so `time < last` also dropped yesterday's candle and lagged every signal by a
 * day — bug fixed in v1.2.)
 */
export function barsFrom(r, now = Date.now()) {
  const raw = (r.candles ?? r.ohlc ?? []).filter(c => (Number(c.time) + 86_400) * 1000 <= now);
  return raw.map(c => ({ time:+c.time, open:+c.open, high:+c.high, low:+c.low, close:+c.close }));
}
function fetchBars(pair) { return barsFrom(ohlc(pair, 1440)); }

function parseCli(out) {
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  for (const c of [...lines].reverse()) {
    if (!c.startsWith('{') && !c.startsWith('[')) continue;
    try { return JSON.parse(c); } catch { /* keep looking */ }
  }
  throw new Error('no JSON in response');
}
async function fetchBarsAsync(pair) {
  const { stdout } = await execFileP(KRAKEN, ['ohlc', pair, '--interval', '1440', '-o', 'json'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
  return barsFrom(parseCli(stdout));
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

// ---- correlation ----------------------------------------------------------
const corrCache = new Map();
function closesFor(pair) {
  try { return dailyBars(pair).map(b => b.close); } catch { return []; }
}
export function corrWith(pairA, pairB, window = CORR_WINDOW) {
  const key = [pairA, pairB].sort().join('|') + `|${window}`;
  if (corrCache.has(key)) return corrCache.get(key);
  const a = closesFor(pairA).slice(-(window + 1)), b = closesFor(pairB).slice(-(window + 1));
  const ra = a.slice(1).map((v,i)=> (v-a[i])/a[i]);
  const rb = b.slice(1).map((v,i)=> (v-b[i])/b[i]);
  const c = pearson(ra, rb);
  corrCache.set(key, c);
  return c;
}

// ---- market regime --------------------------------------------------------
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

// ---- signal ---------------------------------------------------------------
/**
 * Screen one pair on its last completed daily bar. Always returns a diagnostic:
 * `reason` is null when the pair is a valid candidate, else the first filter it failed.
 */
export function screen(pair) {
  const bars = dailyBars(pair);
  if (bars.length < MIN_BARS) return { pair, reason: 'history' };
  const closes = bars.map(b => b.close);
  const a = atr(bars, 14);
  if (!(a > 0)) return { pair, reason: 'atr' };
  const e20 = ema(closes, 20).at(-1);
  const e200 = ema(closes, 200).at(-1);
  const price = closes.at(-1);
  const ext = (e20 - price) / a;               // dip depth in ATRs below EMA20
  const atrPct = (a / price) * 100;
  const sig = {
    side: 'long', pair, price, ext, atr: a, atrPct, barTime: bars.at(-1).time,
    stopPx: price - STOP_ATR * a,
    tpPx: price + TARGET_ATR * a,
    stopPct: STOP_ATR * atrPct,
    targetPct: TARGET_ATR * atrPct,
  };
  sig.reason = !(price > e200) ? 'downtrend'          // pair must be above its EMA200
    : ext < K ? 'shallow'                              // not stretched enough below EMA20
    : atrPct < MIN_ATR_PCT ? 'lowvol'
    : sig.targetPct < MIN_TARGET_PCT ? 'fees'
    : null;
  return sig;
}

/** Valid candidate or null (kept for callers/tests that only need the signal). */
export function analyse(pair) {
  const s = screen(pair);
  return s.reason ? null : s;
}

/** True if the pair was closed during the current UTC day (no same-day re-entry). */
export function inCooldown(state, pair, now = Date.now()) {
  const t = Date.parse(state?.lastExit?.[pair] ?? '');
  return Number.isFinite(t) && t >= Math.floor(now / DAY_MS) * DAY_MS;
}

/** True if the live price drifted too far from the close the signal was computed on. */
export function priceDrifted(signalPrice, livePrice, atrAbs, maxAtr = PRICE_DRIFT_ATR) {
  return !Number.isFinite(livePrice) || Math.abs(livePrice - signalPrice) > maxAtr * atrAbs;
}

// ---- ledger ---------------------------------------------------------------
function readLedger() {
  if (!existsSync(TRADES)) return [];
  return readFileSync(TRADES, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
/** Dedupe key: a position is identified by symbol + openedAt, so a re-run can never double-book it. */
export const tradeKey = (symbol, openedAt) => `${symbol}|${openedAt}`;
export function ledgerHas(recs, symbol, openedAt) {
  const k = tradeKey(symbol, openedAt);
  return recs.some(r => tradeKey(r.symbol, r.openedAt) === k);
}

function reportStats() {
  const recs = readLedger();
  if (recs.length === 0) return;
  const wins = recs.filter(r => r.net >= 0);
  const losses = recs.filter(r => r.net < 0);
  const totalNet = recs.reduce((s, r) => s + r.net, 0);
  const grossWin = wins.reduce((s, r) => s + r.net, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.net, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  let cum = 0, peak = 0, maxDD = 0;
  for (const r of recs) { cum += r.net; if (cum > peak) peak = cum; maxDD = Math.max(maxDD, peak - cum); }
  alert(`STATS trades=${recs.length} wins=${wins.length} losses=${losses.length} win%=${(wins.length/recs.length*100).toFixed(1)} totalNet=${totalNet.toFixed(2)} avgWin=${wins.length? (grossWin/wins.length).toFixed(2):0} avgLoss=${losses.length? (grossLoss/losses.length).toFixed(2):0} PF=${Number.isFinite(pf)?pf.toFixed(2):'inf'} maxDD=${maxDD.toFixed(2)}`);
}

/** Append a closed trade (idempotent) and drop the position from state. Caller saves state. */
function bookClose(state, sym, pos, { exit, size, exitFee, reason }) {
  const entryFee = Number.isFinite(pos.entryFee) ? pos.entryFee * (size / pos.size) : pos.entry * size * FEE_PER_SIDE;
  const gross = (exit - pos.entry) * size;
  const fees = entryFee + exitFee;
  const net = gross - fees;
  if (!ledgerHas(readLedger(), sym, pos.openedAt)) {
    const seq = ++state.tradeSeq;
    const rec = { seq, ts: new Date().toISOString(), symbol: sym, side: 'long',
      entry: pos.entry, exit, size, gross: +gross.toFixed(6),
      fees: +fees.toFixed(6), net: +net.toFixed(6), reason, openedAt: pos.openedAt };
    appendFileSync(TRADES, JSON.stringify(rec) + '\n');
    alert(`${sym} ${net >= 0 ? 'WIN' : 'LOSS'} net=${net.toFixed(4)} reason=${reason} seq=${seq}`);
    if (seq % REPORT_EVERY === 0) reportStats();
  }
  delete state.positions[sym];
  (state.lastExit ||= {})[sym] = new Date().toISOString();   // drives the same-day cooldown
  return { net: +net.toFixed(4) };
}

// ---- reconciliation -------------------------------------------------------
/**
 * Compare tracked positions with real holdings. Pure, unit-tested.
 *  orphans: held on the exchange but not tracked (e.g. a cycle killed right after a buy)
 *  gone:    tracked but no longer held (e.g. the resting take-profit filled)
 *  resized: tracked size differs from the real holding by more than 1%
 */
export function diffPositions(positions, holdings, prices, dustUsd = DUST_USD) {
  const orphans = [], gone = [], resized = [];
  const worth = (pair, qty) => (Number.isFinite(prices[pair]) ? qty * prices[pair] : Infinity);
  for (const [pair, h] of Object.entries(holdings)) {
    if (positions[pair]) continue;
    if (worth(pair, h.total) >= dustUsd) orphans.push({ pair, qty: h.total });
  }
  for (const [pair, pos] of Object.entries(positions)) {
    const qty = holdings[pair]?.total ?? 0;
    if (worth(pair, qty) < dustUsd) { gone.push(pair); continue; }
    if (Math.abs(qty / pos.size - 1) > 0.01) resized.push({ pair, qty });
  }
  return { orphans, gone, resized };
}

function historyTrades() {
  const h = paperHistory();
  return (h?.trades ?? []).map(t => ({ ...t, ts: Date.parse(t.time) }));
}

/** Volume-weighted entry of the buys since the last sell on this pair. */
function inferEntry(trades, pair) {
  const mine = trades.filter(t => norm(t.pair) === norm(pair)).sort((a, b) => a.ts - b.ts);
  let lastSell = -1;
  mine.forEach((t, i) => { if (t.side === 'sell') lastSell = i; });
  const buys = mine.slice(lastSell + 1).filter(t => t.side === 'buy');
  if (buys.length === 0) return null;
  const vol = buys.reduce((s, t) => s + Number(t.volume), 0);
  const cost = buys.reduce((s, t) => s + Number(t.volume) * Number(t.price), 0);
  const fee = buys.reduce((s, t) => s + Number(t.fee || 0), 0);
  return { entry: cost / vol, fee, openedAt: new Date(buys[0].ts).toISOString() };
}

function reconcile(state, holdings, closed) {
  const pairs = [...new Set([...Object.keys(holdings), ...Object.keys(state.positions)])];
  let prices = {};
  try { prices = lastPrices(pairs); } catch { /* unpriced pairs are treated conservatively */ }
  const d = diffPositions(state.positions, holdings, prices);
  if (!d.orphans.length && !d.gone.length && !d.resized.length) return d;

  const trades = historyTrades();
  for (const pair of d.gone) {
    const pos = state.positions[pair];
    const opened = Date.parse(pos.openedAt);
    const sells = trades.filter(t => norm(t.pair) === norm(pair) && t.side === 'sell' && t.ts >= opened);
    const tp = sells.find(t => t.order_id === pos.tpOrderId);
    const fill = tp ?? sells.at(-1);
    const exit = fill ? Number(fill.price) : (prices[pair] ?? pos.tpPx);
    const exitFee = fill ? Number(fill.fee || 0) : exit * pos.size * FEE_PER_SIDE;
    const reason = tp ? 'target_fill' : 'external_close';
    const r = bookClose(state, pair, pos, { exit, size: pos.size, exitFee, reason });
    closed.push(`${pair} ${reason} ${r.net}`);
    saveState(state);
  }

  for (const { pair, qty } of d.resized) {
    alert(`RECONCILE ${pair}: tracked size ${state.positions[pair].size} -> held ${qty}`);
    state.positions[pair].size = qty;
    saveState(state);
  }

  let openOrders = null;
  for (const { pair, qty } of d.orphans) {
    const inf = inferEntry(trades, pair);
    let a = 0;
    try { a = atr(dailyBars(pair), 14); } catch { /* retried next cycle */ }
    if (!inf || !(a > 0)) {
      alert(`RECONCILE ${pair}: untracked holding ${qty} — cannot adopt yet (entry=${!!inf} atr=${a > 0})`);
      continue;
    }
    // drop any stray resting orders on this pair, then re-protect with a fresh TP
    if (openOrders === null) { const oo = paperOrders(); openOrders = oo?.open_orders ?? oo?.orders ?? []; }
    cancelPair(pair, openOrders);
    const pos = {
      side: 'long', size: qty, entry: inf.entry, entryFee: inf.fee,
      stopPx: inf.entry - STOP_ATR * a, tpPx: inf.entry + TARGET_ATR * a, atr: a,
      openedAt: inf.openedAt, entryOrderId: null, tpOrderId: null, adopted: true,
    };
    state.positions[pair] = pos;
    saveState(state);
    sleepSync(500);
    pos.tpOrderId = limitSell(pair, qty, pos.tpPx);
    saveState(state);
    alert(`RECONCILE ${pair}: adopted untracked ${qty} @ ${inf.entry.toFixed(6)} stop=${pos.stopPx.toFixed(6)} tp=${pos.tpPx.toFixed(6)}`);
  }
  return d;
}

// ---- manage ---------------------------------------------------------------
function closePosition(state, sym, pos, price, reason) {
  // release the reserved balance: cancel our TP plus any other resting order on this symbol
  if (pos.tpOrderId) cancel(pos.tpOrderId);
  const oo = paperOrders();
  cancelPair(sym, oo?.open_orders ?? oo?.orders ?? []);
  sleepSync(500);
  const held = holdingsFrom(balance())[sym];
  const qty = floor8(Math.min(pos.size, held?.available ?? 0));
  if (qty * price < MIN_ORDER_USD) {
    // nothing left to sell (TP filled meanwhile) — reconcile books it next cycle from history
    logLine(`close ${sym}: nothing available to sell (held=${held?.total ?? 0}), deferring to reconcile`);
    return null;
  }
  const r = sell(sym, qty);
  const res = bookClose(state, sym, pos, { exit: r.price, size: qty, exitFee: r.fee, reason });
  saveState(state);
  return res;
}

function manage(state) {
  const closed = [];
  const now = Date.now();
  const syms = Object.keys(state.positions);
  let prices = {};
  try { prices = lastPrices(syms); } catch { /* skip this cycle */ }
  for (const sym of syms) {
    const pos = state.positions[sym];
    const price = prices[sym];
    if (!Number.isFinite(price)) continue;
    let reason = null;
    if (price <= pos.stopPx) reason = 'stop';
    else if (price >= pos.tpPx) reason = 'target';
    else if ((now - Date.parse(pos.openedAt)) / DAY_MS >= HOLD_MAX_DAYS) reason = 'timestop';
    if (reason) {
      const r = closePosition(state, sym, pos, price, reason);
      if (r) closed.push(`${sym} ${reason} ${r.net}`);
      continue;
    }
    // optional protection: move stop to break-even (fees covered) once price has run enough
    if (PROTECT !== 'off' && price > pos.entry) {
      const feeCostPerUnit = pos.entry * FEE_PER_SIDE * 2;
      if (price - pos.entry >= feeCostPerUnit) {
        const be = pos.entry + feeCostPerUnit;
        if (be > pos.stopPx) { pos.stopPx = be; saveState(state); }
      }
    }
  }
  sweepStale(state);
  return closed;
}

/** Cancel resting orders on symbols we no longer hold. Never cancels a tracked take-profit. */
function sweepStale(state) {
  const oo = paperOrders();
  const orders = oo?.open_orders ?? oo?.orders ?? [];
  const held = new Set(Object.keys(state.positions).map(norm));
  const tracked = new Set(Object.values(state.positions).map(p => p.tpOrderId).filter(Boolean));
  for (const o of orders) {
    const id = o.order_id ?? o.id;
    if (!id || tracked.has(id)) continue;
    if (!held.has(norm(o.pair ?? o.symbol))) cancel(id);
  }
}

// ---- entry ----------------------------------------------------------------
function blockedByCorr(pair, heldSymbols) {
  for (const h of heldSymbols) {
    if (Math.abs(corrWith(pair, h)) > CORR_MAX) return h;
  }
  return null;
}

/**
 * Trades that measure the strategy: its own exits, since the v1.2 rules went live.
 * Forced liquidations from old bugs (bust/flatten), manual closes and external closes
 * say nothing about the signal and must not trip the freeze.
 */
export const STRATEGY_EPOCH = '2026-10-31T14:15:00.000Z';
const STRATEGY_REASONS = new Set(['stop', 'target', 'target_fill', 'timestop']);
export function strategyTrades(recs, epoch = STRATEGY_EPOCH) {
  const t0 = Date.parse(epoch);
  return recs.filter(r => STRATEGY_REASONS.has(r.reason) && Date.parse(r.ts) >= t0);
}

function freezeTripped() {
  const clear = () => { try { unlinkSync(FREEZE_FILE); } catch { /* none */ } };
  const recs = strategyTrades(readLedger());
  if (recs.length <= FREEZE_MIN_TRADES) { clear(); return false; }
  const winRate = recs.filter(r => r.net >= 0).length / recs.length;
  if (winRate >= FREEZE_WINRATE) { clear(); return false; }
  writeFileSync(FREEZE_FILE, `${new Date().toISOString()} winRate=${(winRate*100).toFixed(1)}% over ${recs.length} trades\n`);
  alert(`FREEZE: win rate ${(winRate*100).toFixed(1)}% < ${FREEZE_WINRATE*100}% over ${recs.length} trades — entries halted`);
  return true;
}

function entry(state, cur, holdings, dryRun = false) {
  const entered = [];
  if (freezeTripped()) return { entered, near: [], frozen: true };
  if (verdict(cur) !== 'RUNNING') return { entered, near: [] };
  let market;
  try { market = marketRegime(); } catch { market = { ok: false }; }

  // screen every pair we could buy, keeping the rejection reason for the `near` report
  const screened = [];
  for (const pair of UNIVERSE) {
    if (state.positions[pair] || holdings[pair]) continue;   // never buy what we already hold
    let s;
    try { s = screen(pair); } catch { continue; }
    if (!Number.isFinite(s.ext)) continue;
    if (!s.reason && inCooldown(state, pair)) s.reason = 'cooldown';
    if (!s.reason && !market.ok) s.reason = 'regime';
    screened.push(s);
  }
  screened.sort((a, b) => b.ext - a.ext);
  const nearOf = () => screened.slice(0, 5).map(s => `${s.pair}:${s.ext.toFixed(2)}${s.reason ? `(${s.reason})` : ''}`);
  if (!market.ok) return { entered, near: nearOf(), market: { ok: false, reason: market.reason } };

  const cands = screened.filter(s => !s.reason);
  let live = {};
  if (cands.length) { try { live = lastPrices(cands.map(c => c.pair)); } catch { /* every candidate counts as drifted */ } }
  let allowed = budgetFor(cur, state).allowed;
  for (const sig of cands) {
    if (Object.keys(state.positions).length >= MAX_CONCURRENT || allowed <= 0) { sig.reason = 'full'; continue; }
    // correlation against everything held now, including entries made earlier in this loop
    const blocker = blockedByCorr(sig.pair, Object.keys(state.positions));
    if (blocker) { sig.reason = `corr:${blocker.split('/')[0]}`; continue; }
    // the signal is from the last daily close; only act if the live price is still close to it
    const px = live[sig.pair];
    if (priceDrifted(sig.price, px, sig.atr)) { sig.reason = 'drift'; continue; }
    const stopDist = STOP_ATR * sig.atr;
    let size = allowed / stopDist;
    const maxNotional = cur * MAX_NOTIONAL_PCT;
    if (size * px > maxNotional) size = maxNotional / px;
    size = floor8(size);
    if (size * px < MIN_ORDER_USD) { sig.reason = 'size'; continue; }
    if (dryRun) {
      entered.push(`dry ${sig.pair} ext=${sig.ext.toFixed(2)} size=${size}`);
      allowed = Math.max(0, allowed - stopDist * size);
      continue;
    }
    let r;
    try { r = buy(sig.pair, size); }
    catch (e) { logLine(`entry failed ${sig.pair}: ${e.message}`); continue; }
    // persist the fill before anything else can fail
    const stopPx = r.price - STOP_ATR * sig.atr;
    const tpPx = r.price + TARGET_ATR * sig.atr;
    const pos = {
      side: 'long', size: r.size, entry: r.price, entryFee: r.fee, stopPx, tpPx,
      atr: sig.atr, ext: sig.ext, openedAt: new Date().toISOString(),
      entryOrderId: r.orderId, tpOrderId: null,
    };
    state.positions[sig.pair] = pos;
    saveState(state);
    pos.tpOrderId = limitSell(sig.pair, r.size, tpPx);
    saveState(state);
    allowed = Math.max(0, allowed - (r.price - stopPx) * r.size);
    entered.push(`${sig.pair} ext=${sig.ext.toFixed(2)}`);
    sig.reason = 'entered';
  }
  return { entered, near: nearOf() };
}

// ---- main -----------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('unfreeze')) {
    try { unlinkSync(FREEZE_FILE); } catch {}
    console.log(JSON.stringify({ unfrozen: true }));
    return;
  }
  if (args.includes('freeze-status')) {
    console.log(JSON.stringify({ frozen: existsSync(FREEZE_FILE), file: FREEZE_FILE }));
    return;
  }
  if (args[0] === 'close') {
    // manual close through the normal path: cancel TP, market sell, ledger, cooldown, save
    const state = loadState();
    const want = args[1] === 'all' ? Object.keys(state.positions) : args.slice(1);
    const closed = [];
    for (const sym of want) {
      const pos = state.positions[sym];
      if (!pos) { closed.push(`${sym} not held`); continue; }
      const r = closePosition(state, sym, pos, lastPrice(sym), 'manual');
      closed.push(r ? `${sym} manual ${r.net}` : `${sym} nothing to sell (reconcile will book it)`);
    }
    saveState(state);
    console.log(JSON.stringify({ closed, positions: Object.keys(state.positions).length }));
    return;
  }
  if (existsSync(HALTED)) {
    console.log(JSON.stringify({ positions: 0, closed: [], entered: [], halted: true }));
    return;
  }
  const noEntry = args.includes('noentry');
  const dryRun = args.includes('--dry-run');
  try {
    const pw = await prewarm();
    if (pw.fetched || pw.failed) logLine(`prewarm: refreshed=${pw.fetched} failed=${pw.failed} of ${pw.total}`);
  } catch (e) { logLine(`prewarm failed: ${e.message}`); }

  const state = loadState();
  const bal = balance();
  if (!bal) throw new Error('balance unavailable');
  const closed = [];
  const rec = reconcile(state, holdingsFrom(bal), closed);

  const closedByManage = manage(state);
  closed.push(...closedByManage);

  const g = equity();
  const holdings = holdingsFrom(g.bal ?? bal);
  const er = noEntry ? { entered: [], near: [] } : entry(state, g.cur, holdings, dryRun);

  // flatten only on a terminal verdict that survives a second read
  const cv = confirmedVerdict(g);
  if (cv.glitch) logLine(`verdict glitch ignored: ${JSON.stringify(cv.glitch)}`);
  if (cv.verdict !== 'RUNNING') {
    for (const sym of Object.keys(state.positions)) {
      try {
        const r = closePosition(state, sym, state.positions[sym], lastPrice(sym), cv.verdict.toLowerCase());
        if (r) closed.push(`${sym} ${cv.verdict.toLowerCase()} ${r.net}`);
      } catch (e) { logLine(`flatten failed ${sym}: ${e.message}`); }
    }
    writeFileSync(HALTED, `${new Date().toISOString()} ${cv.verdict} equity=${cv.cur.toFixed(2)}\n`);
    alert(`HALTED: confirmed ${cv.verdict} at $${cv.cur.toFixed(2)}`);
  }
  saveState(state);
  console.log(JSON.stringify({
    positions: Object.keys(state.positions).length,
    closed,
    entered: er.entered ?? [],
    near: er.near,
    frozen: !!er.frozen,
    reconciled: { orphans: rec.orphans.length, gone: rec.gone.length, resized: rec.resized.length },
    equitySource: g.source,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.log(JSON.stringify({ error: e.stack || e.message }));
    process.exit(1);
  });
}
