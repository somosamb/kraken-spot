#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const DIR = '/home/oc/kraken-spot';
const KRAKEN = '/home/oc/bin/kraken';
const WS = 'spotbot';
let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  ' + d : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`); };
const chk = (c, n, d = '') => (c ? ok(n, d) : bad(n, d));

const LOCK_HINT = 'in use by another process';
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const cli = (args, tries = 12) => {
  for (let i = 0; i < tries; i++) {
    if (i) sleepSync(5000);
    try {
      return JSON.parse(execFileSync(KRAKEN, ['--workspace', WS, ...args]).toString().trim().split('\n').pop());
    } catch (e) {
      const msg = String(e.stdout ?? '') + String(e.stderr ?? '') + String(e.message ?? '');
      if (!msg.includes(LOCK_HINT)) throw e;
    }
  }
  console.log('\nCANNOT VALIDATE: paper state lock held');
  process.exit(2);
};

console.log(`\n=== VALIDATION  ${new Date().toISOString()} ===\n`);

console.log('[1] code parses');
for (const f of ['ctl.mjs', 'spot.mjs', 'trader.mjs', 'runner.mjs', 'riskpolicy.mjs', 'validate.mjs']) {
  try { execFileSync('node', ['--check', `${DIR}/${f}`]); ok(`${f} parses`); }
  catch (e) { bad(`${f} parses`, e.message.slice(0, 80)); }
}
try { execFileSync('sh', ['-n', `${DIR}/watchdog.sh`]); ok('watchdog.sh parses'); }
catch (e) { bad('watchdog.sh parses', e.message.slice(0, 80)); }

console.log('\n[2] constants');
const trader = readFileSync(`${DIR}/trader.mjs`, 'utf8');
const KV = (k) => Number((trader.match(new RegExp(`const ${k} = ([\\d.]+);`, 'm')) ?? [])[1]);
chk(KV('K') === 1.25, 'K = 1.25');
chk(KV('MIN_TARGET_PCT') === 1.6, 'MIN_TARGET_PCT = 1.6');
chk(KV('TARGET_ATR') === 0.75, 'TARGET_ATR = 0.75');
chk(/price > e200/.test(trader), 'per-pair EMA200 uptrend filter');
chk(/FREEZE_MIN_TRADES = 15/.test(trader) && /FREEZE_WINRATE = 0\.55/.test(trader), 'freeze 15 trades / 55% with auto-clear');
chk(/export function marketRegime/.test(trader), 'BTC market regime filter');
chk(/ohlc\.1d\.cache\.json/.test(trader) && /entry\.ts >= todayStart/.test(trader), 'daily OHLC disk cache (1 refresh/day)');
chk(/export async function prewarm/.test(trader), 'parallel prewarm (bounded concurrency)');
chk(/never cancel a live take-profit/.test(trader), 'stale-order sweep protects live TPs');
chk(/paper', 'cancel', String\(orderId\)/.test(readFileSync(`${DIR}/spot.mjs`, 'utf8')), 'cancel uses positional order id');
chk(KV('STOP_ATR') === 1.5, 'STOP_ATR = 1.5');
chk(/entryPx - STOP_ATR \* sig\.atr/.test(trader), 'stop/target re-anchored to fill price');
chk(KV('HOLD_MAX_DAYS') === 10, 'HOLD_MAX_DAYS = 10');
chk(/ohlc\(pair, 1440\)/.test(trader), 'signals on daily bars (1440)');
chk(/CYCLE_TIMEOUT_MS = 600_000/.test(readFileSync(`${DIR}/runner.mjs`, 'utf8')), 'cycle timeout 600s');
chk(KV('MAX_CONCURRENT') === 2, 'MAX_CONCURRENT = 2');
chk(KV('CORR_MAX') === 0.65, 'CORR_MAX = 0.65');

console.log('\n[3] processes');
const ps = execFileSync('ps', ['-eo', 'pid,args']).toString();
const runnerLines = ps.split('\n').filter((l) => /^\s*\d+\s+(?:[\w./-]*\/)?node runner\.mjs\s*$/.test(l));
const wdLines = ps.split('\n').filter((l) => /^\s*\d+\s+(?:[\w./-]*\/)?sh watchdog\.sh\s*$/.test(l));
chk(runnerLines.length <= 1, 'at most one runner', runnerLines.length);
chk(wdLines.length <= 1, 'at most one watchdog', wdLines.length);

console.log('\n[4] exchange state');
const st = cli(['paper', 'status', '-o', 'json']);
const eq = Number(st.current_value);
chk(Number.isFinite(eq), 'equity readable', String(eq));
chk(eq > 970, 'equity above floor', `cushion $${(eq - 970).toFixed(2)}`);

console.log('\n[5] local state');
const state = existsSync(`${DIR}/state.json`) ? JSON.parse(readFileSync(`${DIR}/state.json`, 'utf8')) : null;
chk(!!state, 'state.json exists');
if (state) {
  chk(typeof state.positions === 'object', 'positions object');
  const localSyms = Object.keys(state.positions);
  chk(localSyms.length <= 2, 'positions <= MAX_CONCURRENT', String(localSyms.length));
}

console.log('\n[6] ledger');
const hist = cli(['paper', 'history', '-o', 'json']);
const trades = hist.trades ?? [];
console.log(`  info  ${trades.length} closed trades`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log(fail === 0 ? 'SYSTEM CONSISTENT' : 'INCONSISTENCIES FOUND');
process.exit(fail === 0 ? 0 : 1);
