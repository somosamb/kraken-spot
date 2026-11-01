#!/usr/bin/env node
/**
 * Kraken Spot Paper — controller.
 *
 * Rules (mirrors the challenge semantics for comparability):
 *   start equity      $1000
 *   profit target     +12%  -> $1120  = PASS
 *   loss floor         -3%  -> $970   = GAME OVER (static, from start balance)
 *   no daily limit, no time limit
 *
 * Environment:
 *   KS_DIR        working directory for state/logs (default: this file's directory)
 *   KRAKEN_BIN    kraken CLI binary (default: `kraken` on PATH)
 *   KS_WORKSPACE  paper workspace name (default: spotbot)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KRAKEN = process.env.KRAKEN_BIN || 'kraken';
export const WS = process.env.KS_WORKSPACE || 'spotbot';
export const DIR = process.env.KS_DIR || dirname(fileURLToPath(import.meta.url));
export const STATE = `${DIR}/state.json`;
export const EQUITY_CSV = `${DIR}/equity.csv`;
export const TRADES = `${DIR}/trades.jsonl`;
export const HALTED = `${DIR}/HALTED`;

export const RULES = {
  start: 1000,
  targetPct: 12,
  floorPct: 3,
  get target() { return this.start * (1 + this.targetPct / 100); },
  get floor() { return this.start * (1 - this.floorPct / 100); },
};

export const FEE_PER_SIDE = 0.0026;   // spot paper taker fee, 0.26%
/** Venue and own valuation must agree within this fraction, else the venue figure is rejected. */
export const VALUATION_TOLERANCE = 0.01;
/** Holdings worth less than this are treated as dust. */
export const DUST_USD = 1;

function parseResult(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const c of [...lines].reverse()) {
    if (!c.startsWith('{') && !c.startsWith('[')) continue;
    try { return JSON.parse(c); } catch { /* keep looking */ }
  }
  throw new Error(`no JSON in response: ${out.slice(0, 200)}`);
}

const LOCK_MSG = 'in use by another process';
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Environment for the CLI. glibc sends the A and AAAA DNS queries together on one socket;
 * some routers drop the second, so every lookup waited a 5 s timeout before retrying
 * (2026-11-01, home wifi: 6.0 s per CLI call -> 0.7 s with this option). Sequential
 * queries cost at most one extra DNS round trip. An explicit RES_OPTIONS is respected.
 */
export const CLI_ENV = { ...process.env, RES_OPTIONS: process.env.RES_OPTIONS ?? 'single-request-reopen' };

/** Calls slower than this, or that needed lock retries, are recorded in kraken-calls.log. */
const SLOW_CALL_MS = 3000;

/** True for failures caused by connectivity (not by the exchange rejecting a request). */
export function isNetworkError(msg = '', err = {}) {
  if (err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') return true;
  return /network error|error sending request|timed? ?out|dns|connection (refused|reset|closed)|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|unreachable|tls|certificate/i.test(msg);
}

// per-process call statistics, drained once per cycle by takeCallStats()
let callLog = [];
/** Return and reset this process's CLI call stats: { n, netFails, ms: [...] }. */
export function takeCallStats() {
  const s = { n: callLog.length, netFails: callLog.filter(c => c.net).length, ms: callLog.map(c => c.ms) };
  callLog = [];
  return s;
}

function noteCall(args, t0, attempts, outcome) {
  const ms = Date.now() - t0;
  callLog.push({ ms, net: outcome === 'neterror' || outcome === 'timeout' || outcome === 'netwarn' });
  if (callLog.length > 500) callLog.shift();
  if (ms < SLOW_CALL_MS && attempts === 0 && outcome === 'ok') return;
  try {
    appendFileSync(`${DIR}/kraken-calls.log`,
      `${new Date().toISOString()} ${ms}ms lockRetries=${attempts} ${outcome} ${args.filter(a => a !== '-o' && a !== 'json').slice(0, 4).join(' ')}\n`);
  } catch { /* diagnostics only */ }
}

export function kraken(args, { allowFail = false, retries = 8, workspace = true } = {}) {
  let lastErr = null;
  const full = workspace ? ['--workspace', WS, ...args] : args;
  const t0 = Date.now();
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) sleepSync(400 + attempt * 350);
    try {
      // spawnSync (not execFileSync) so stderr is visible even when the command succeeds:
      // the CLI can return data while warning "could not sync … Network error" on stderr.
      const r = spawnSync(KRAKEN, full, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
        env: CLI_ENV,
      });
      if (r.error || r.status !== 0) {
        const e = r.error ?? new Error(`exit ${r.status}`);
        Object.assign(e, { stderr: r.stderr, stdout: r.stdout, signal: r.signal ?? e.signal });
        throw e;
      }
      const out = r.stdout ?? '';
      if (!out.trim()) throw new Error('empty response');
      const res = parseResult(out);
      noteCall(args, t0, attempt, isNetworkError(r.stderr ?? '') ? 'netwarn' : 'ok');
      return res;
    } catch (err) {
      const msg = (err.stderr || err.stdout || err.message || '').toString().trim();
      if (msg.includes(LOCK_MSG)) { lastErr = msg; continue; }
      noteCall(args, t0, attempt,
        err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM' ? 'timeout' : isNetworkError(msg, err) ? 'neterror' : 'error');
      if (allowFail) return null;
      throw new Error(`kraken ${args.join(' ')} -> ${msg.slice(0, 400)}`);
    }
  }
  noteCall(args, t0, retries + 1, 'lock');
  if (allowFail) return null;
  throw new Error(`kraken ${args.join(' ')} -> lock still held after ${retries + 1} tries: ${lastErr?.slice(0, 200)}`);
}

// spot paper (workspace-scoped)
export const status = () => kraken(['paper', 'status', '-o', 'json']);
export const balance = () => kraken(['paper', 'balance', '-o', 'json'], { allowFail: true });
export const paperOrders = () => kraken(['paper', 'orders', '-o', 'json'], { allowFail: true });
export const paperHistory = () => kraken(['paper', 'history', '-o', 'json'], { allowFail: true });
// market data (global)
export const ticker = (...pairs) => kraken(['ticker', ...pairs, '-o', 'json'], { workspace: false, retries: 2 });
export const ohlc = (pair, interval = 60) => kraken(['ohlc', pair, '--interval', String(interval), '-o', 'json'], { workspace: false, retries: 2 });

// ---- state ------------------------------------------------------------------
export function loadState() {
  if (!existsSync(STATE)) {
    mkdirSync(DIR, { recursive: true });
    saveState({
      createdAt: new Date().toISOString(),
      status: 'RUNNING',
      peak: RULES.start,
      trough: RULES.start,
      positions: {},
      tradeSeq: 0,
      lastEquity: RULES.start,
    });
  }
  return JSON.parse(readFileSync(STATE, 'utf8'));
}
/** Atomic write: a crash mid-write can never leave a truncated state.json. */
export function saveState(s) {
  const tmp = `${STATE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE);
}

// ---- prices -----------------------------------------------------------------
export function pickPrice(t) {
  const px = Number(t?.last_price ?? t?.last ?? t?.ask_price ?? t?.bid_price ?? t?.price);
  return Number.isFinite(px) && px > 0 ? px : null;
}

export function lastPrice(pair) {
  const t = ticker(pair);
  const v = Array.isArray(t) ? t[0] : (t?.[pair] ?? t?.[pair.replace('/', '')] ?? t);
  const px = pickPrice(v);
  if (px === null) throw new Error(`bad ticker for ${pair}: ${JSON.stringify(t).slice(0, 200)}`);
  return px;
}

/** Prices for several pairs in one CLI call. Missing pairs are simply absent. */
export function lastPrices(pairs) {
  if (pairs.length === 0) return {};
  const t = ticker(...pairs);
  const out = {};
  for (const p of pairs) {
    const px = pickPrice(t?.[p] ?? t?.[p.replace('/', '')]);
    if (px !== null) out[p] = px;
  }
  return out;
}

/** Non-USD holdings from a `paper balance` response: { 'BTC/USD': {total, reserved, available} }. */
export function holdingsFrom(bal) {
  const out = {};
  for (const [asset, v] of Object.entries(bal?.balances ?? {})) {
    if (asset === 'USD') continue;
    const total = Number(v.total);
    if (!(total > 0)) continue;
    out[`${asset}/USD`] = { total, reserved: Number(v.reserved) || 0, available: Number(v.available) || 0 };
  }
  return out;
}

/**
 * Own mark-to-market valuation: USD + sum(holding * last price).
 * Returns null if any holding cannot be priced (valuation would be incomplete).
 */
export function ownValuation(bal, prices) {
  const usd = Number(bal?.balances?.USD?.total);
  if (!Number.isFinite(usd)) return null;
  let total = usd;
  for (const [pair, h] of Object.entries(holdingsFrom(bal))) {
    const px = prices[pair];
    if (!Number.isFinite(px)) return null;
    total += h.total * px;
  }
  return total;
}

/**
 * Decide which equity figure to trust. Pure, unit-tested.
 * The venue figure is rejected when it flags itself incomplete or disagrees with our own valuation.
 */
export function chooseEquity(venue, own, tolerance = VALUATION_TOLERANCE) {
  const v = Number(venue?.current_value ?? venue?.equity);
  const venueOk = Number.isFinite(v) && venue?.valuation_complete !== false;
  if (own !== null && Number.isFinite(own)) {
    if (venueOk && Math.abs(v / own - 1) <= tolerance) return { cur: v, source: 'venue' };
    return { cur: own, source: 'own', rejected: Number.isFinite(v) ? v : null };
  }
  if (venueOk) return { cur: v, source: 'venue-unverified' };
  throw new Error('equity unavailable: venue valuation incomplete and own valuation failed');
}

export function equity() {
  const st = status();
  const bal = balance();
  let own = null;
  if (bal) {
    try { own = ownValuation(bal, lastPrices(Object.keys(holdingsFrom(bal)))); } catch { own = null; }
  }
  const c = chooseEquity(st, own);
  return { ...c, st, bal };
}

export function verdict(cur) {
  if (cur >= RULES.target) return 'PASS';
  if (cur <= RULES.floor) return 'BUST';
  return 'RUNNING';
}

/**
 * A terminal verdict (PASS/BUST) liquidates and halts the bot, so it must survive a
 * second independent read a few seconds later. Otherwise the reading is treated as a glitch.
 */
export function confirmedVerdict(first, delayMs = 5000) {
  const v1 = verdict(first.cur);
  if (v1 === 'RUNNING') return { verdict: v1, cur: first.cur };
  sleepSync(delayMs);
  const second = equity();
  const v2 = verdict(second.cur);
  if (v2 === v1) return { verdict: v1, cur: second.cur, confirmed: true };
  return { verdict: 'RUNNING', cur: second.cur, glitch: { first: first.cur, second: second.cur } };
}

export function snapshot(note = '') {
  const e = equity();
  const { cur } = e;
  const s = loadState();
  s.peak = Math.max(s.peak, cur);
  s.trough = Math.min(s.trough, cur);
  s.lastEquity = cur;
  s.status = verdict(cur);
  saveState(s);

  if (!existsSync(EQUITY_CSV)) {
    appendFileSync(EQUITY_CSV, 'ts,equity,pnl_pct,progress_to_target,source,note\n');
  }
  const pnl = ((cur - RULES.start) / RULES.start) * 100;
  const progress = ((cur - RULES.start) / (RULES.target - RULES.start)) * 100;
  appendFileSync(EQUITY_CSV,
    `${new Date().toISOString()},${cur.toFixed(2)},${pnl.toFixed(3)},${progress.toFixed(2)},${e.source},"${note.replace(/"/g, "'")}"\n`);
  return { cur, pnl, progress, status: s.status, source: e.source, rejected: e.rejected ?? null, equity: e };
}

const f = (n, d = 2) => Number(n).toFixed(d);

export function report() {
  const e = equity();
  const { cur, bal } = e;
  const s = loadState();
  const v = verdict(cur);
  const pnl = ((cur - RULES.start) / RULES.start) * 100;
  const progress = ((cur - RULES.start) / (RULES.target - RULES.start)) * 100;
  const distFloor = ((cur - RULES.floor) / RULES.start) * 100;
  const distTarget = ((RULES.target - cur) / RULES.start) * 100;
  const open = paperOrders() ?? {};
  const openOrders = open.open_orders ?? open.orders ?? [];
  const halted = existsSync(HALTED);
  let netLine = 'net      unknown (runner not started yet)';
  try {
    const n = JSON.parse(readFileSync(`${DIR}/net.state.json`, 'utf8'));
    const mins = Math.round((Date.now() - n.net.since) / 60000);
    netLine = `net      ${n.net.state} for ${mins} min  probe ${n.probeMs}ms  ${n.net.state === 'OK' ? '' : 'entries blocked'}`;
  } catch { /* no runner yet */ }

  const bar = (pct, w = 26) => {
    const n = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
    return '█'.repeat(n) + '░'.repeat(w - n);
  };
  const tag = halted ? 'HALTED (see HALTED file)' : v === 'PASS' ? '🎉 TARGET REACHED' : v === 'BUST' ? '💀 FLOOR BREACHED' : 'in play';
  const row = (t) => `│ ${t}`.padEnd(56) + '│';

  const lines = [
    `┌──────────────── KRAKEN SPOT PAPER ────────────────┐`,
    row(`status   ${v.padEnd(10)} ${tag}`),
    row(`equity   $${f(cur)}   start $${f(RULES.start)}   P&L ${pnl >= 0 ? '+' : ''}${f(pnl)}%`),
    row(`target   $${f(RULES.target)} (+${RULES.targetPct}%)   floor $${f(RULES.floor)} (-${RULES.floorPct}%)`),
    row(`progress ${bar(progress)} ${f(progress, 1)}%`),
    row(`runway   ${f(distTarget)}% to PASS  |  ${f(distFloor)}% to BUST`),
    row(`peak     $${f(s.peak)}   trough $${f(s.trough)}   src ${e.source}`),
    row(`cash     $${f(Number(bal?.balances?.USD?.available ?? 0))}   positions ${Object.keys(s.positions).length}   openOrders ${openOrders.length}`),
    row(netLine),
    `└──────────────────────────────────────────────────┘`,
  ];
  return { text: lines.join('\n'), cur, verdict: v, progress, pnl, state: s, source: e.source, halted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'status' || !cmd) {
      console.log(report().text);
    } else if (cmd === 'json') {
      const r = report();
      console.log(JSON.stringify({ equity: r.cur, verdict: r.verdict, progress: r.progress, pnl: r.pnl, source: r.source, halted: r.halted, state: r.state }));
    } else if (cmd === 'snapshot') {
      const r = snapshot(rest.join(' '));
      console.log(JSON.stringify({ cur: r.cur, pnl: r.pnl, progress: r.progress, status: r.status, source: r.source }));
    } else if (cmd === 'guard') {
      const e = equity();
      const c = confirmedVerdict(e);
      console.log(JSON.stringify({ equity: c.cur, verdict: c.verdict, source: e.source, target: RULES.target, floor: RULES.floor }));
      if (c.verdict === 'BUST') process.exitCode = 2;
    } else {
      console.error(`unknown command: ${cmd}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}
