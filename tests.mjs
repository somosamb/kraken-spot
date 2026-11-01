#!/usr/bin/env node
/**
 * Pure unit tests — no network, no exchange calls. Run: node tests.mjs
 */
import { readFileSync } from 'node:fs';
import { riskFor, scaledRiskFor, RISK_MULT } from './riskpolicy.mjs';
import { analyse, screen, inCooldown, priceDrifted, corrWith, diffPositions, ledgerHas, barsFrom, strategyTrades } from './trader.mjs';
import { chooseEquity, ownValuation, holdingsFrom, verdict, confirmedVerdict, DIR, isNetworkError } from './ctl.mjs';
import { initialNet, step as netStep, entriesAllowed, p90 } from './net.mjs';
import { parseFill } from './spot.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('risk ladder');
for (const eq of [975, 990, 1000, 1050, 1119]) {
  const r = riskFor(eq);
  ok(r <= 0.2 * (eq - 970) + 1e-9, `risk $${r.toFixed(2)} <= 20% of cushion at $${eq}`);
}
ok(riskFor(970) === 0, 'risk 0 at floor');
ok(near(scaledRiskFor(1000), riskFor(1000) * RISK_MULT, 1e-3) && RISK_MULT === 3, 'policy = ladder x3 below the ratchet');
ok(scaledRiskFor(1119) === 75, 'policy capped at $75');
ok(scaledRiskFor(970) === 0, 'policy 0 at floor (cushion-proportional: losing streaks cannot reach it)');

console.log('verdict');
ok(verdict(1120) === 'PASS' && verdict(970) === 'BUST' && verdict(1000) === 'RUNNING', 'PASS / BUST / RUNNING thresholds');
ok(confirmedVerdict({ cur: 1000 }).verdict === 'RUNNING', 'non-terminal verdict needs no second read');

console.log('screening');
// uptrend then a sharp dip; `vol` = half the daily range as a fraction of price
const mkBars = (vol, dipDays = 6, dipPct = 0.035) => {
  const out = [];
  let p = 100;
  for (let i = 0; i < 240; i++) {
    p = i < 240 - dipDays ? p * 1.004 : p * (1 - dipPct);
    out.push({ time: i * 86400, open: p, high: p * (1 + vol), low: p * (1 - vol), close: p });
  }
  return out;
};
const volatile = mkBars(0.03);          // ATR ~6% of price
const quiet = mkBars(0.006, 6, 0.012);  // same shape, ATR ~1.5% of price
const downtrend = mkBars(0.03).map((b, i, a) => ({ ...a[a.length - 1 - i], time: b.time }));
const shallow = mkBars(0.03, 1, 0.01);
const flat = Array.from({ length: 80 }, () => ({ high: 101, low: 99, close: 100 }));
globalThis.__TEST_BARS__ = { 'TEST/USD': volatile, 'TWIN/USD': volatile, 'QUIET/USD': quiet,
  'DOWN/USD': downtrend, 'SHALLOW/USD': shallow, 'FLAT/USD': flat };
const sig = analyse('TEST/USD');
ok(sig && sig.side === 'long' && sig.reason === null, 'volatile dip in uptrend -> candidate');
ok(sig && sig.stopPx < sig.price && sig.tpPx > sig.price, 'stop < entry < target');
ok(sig && near((sig.tpPx - sig.price) / (sig.price - sig.stopPx), 0.5, 1e-6), 'target = 0.5R (0.75 / 1.5 ATR)');
ok(sig && sig.atrPct >= 3 && sig.barTime === volatile.at(-1).time, 'diagnostic carries ATR% and signal bar time');
ok(screen('QUIET/USD').reason === 'lowvol' && analyse('QUIET/USD') === null, 'same dip with ATR < 3% -> rejected as lowvol (TRX fix)');
ok(screen('DOWN/USD').reason === 'downtrend', 'price below EMA200 -> downtrend');
ok(screen('SHALLOW/USD').reason === 'shallow', 'dip smaller than K ATR -> shallow');
ok(screen('FLAT/USD').reason === 'history', 'short history -> history');

console.log('daily candles (one-day-lag fix)');
const day = 86400, t0 = 1793232000;   // 2026-10-29T00:00Z
const resp = { last: t0 + day, candles: [0, 1, 2].map(k => ({ time: t0 + k * day, open: 1, high: 1, low: 1, close: k })) };
const kept = barsFrom(resp, (t0 + 2 * day + 14 * 3600) * 1000);   // 2026-10-31 14:00Z
ok(kept.length === 2 && kept.at(-1).time === t0 + day, "yesterday's completed candle kept, today's forming candle dropped");
ok(barsFrom(resp, (t0 + 3 * day) * 1000).length === 3, 'a candle counts as complete exactly when its 24h end');

console.log('entry guards');
const now = Date.UTC(2026, 9, 31, 15, 0, 0);
ok(inCooldown({ lastExit: { 'X/USD': '2026-10-31T09:00:00.000Z' } }, 'X/USD', now), 'exit earlier today -> cooldown (no same-day re-entry)');
ok(!inCooldown({ lastExit: { 'X/USD': '2026-10-30T23:59:00.000Z' } }, 'X/USD', now), 'exit yesterday -> free on a new daily bar');
ok(!inCooldown({}, 'X/USD', now) && !inCooldown(undefined, 'X/USD', now), 'never exited -> no cooldown');
ok(!priceDrifted(100, 100.9, 2), 'live price within 0.5 ATR of the signal close -> ok');
ok(priceDrifted(100, 101.1, 2) && priceDrifted(100, 98.9, 2), 'live price beyond 0.5 ATR either way -> drifted');
ok(priceDrifted(100, NaN, 2), 'no live price -> treated as drifted');

console.log('correlation');
ok(near(corrWith('TEST/USD', 'TWIN/USD'), 1, 1e-9), 'corrWith of identical series = 1 (offline)');
const tailSame = volatile.map((b, i) => (i < 150 ? { ...b, close: b.close * (1 + 0.05 * Math.sin(i)) } : b));
globalThis.__TEST_BARS__['TAIL/USD'] = tailSame;
ok(near(corrWith('TEST/USD', 'TAIL/USD'), 1, 1e-9), 'corr uses only the last 60 days (older divergence ignored)');
ok(corrWith('TEST/USD', 'TAIL/USD', 239) < 0.99, 'a full-history window would see the divergence');

console.log('equity selection (false-BUST fix)');
const bal = { balances: {
  USD: { total: '915.36', available: '915.36' },
  BTC: { total: '0.001', reserved: '0.001', available: '0' },
  ARB: { total: '100', reserved: '0', available: '100' },
  DOT: { total: '0.00000000' },
} };
const h = holdingsFrom(bal);
ok(Object.keys(h).sort().join() === 'ARB/USD,BTC/USD', 'holdingsFrom skips USD and zero balances');
ok(near(ownValuation(bal, { 'BTC/USD': 70000, 'ARB/USD': 0.2 }), 915.36 + 70 + 20, 1e-6), 'own valuation = cash + marked holdings');
ok(ownValuation(bal, { 'BTC/USD': 70000 }) === null, 'own valuation is null if a holding is unpriced');
ok(chooseEquity({ current_value: 1005, valuation_complete: true }, 1005.5).source === 'venue', 'venue accepted when it agrees');
const cash = chooseEquity({ current_value: 724.58, valuation_complete: true }, 995.07);
ok(cash.source === 'own' && cash.cur === 995.07 && cash.rejected === 724.58, 'cash-only venue reading rejected (the $724.58 bug)');
ok(chooseEquity({ current_value: 995, valuation_complete: false }, 994).source === 'own', 'incomplete venue valuation rejected');
ok(chooseEquity({ current_value: 995 }, null).source === 'venue-unverified', 'venue used when own valuation unavailable');
ok(throws(() => chooseEquity({ current_value: 995, valuation_complete: false }, null)), 'no trustworthy figure -> throws');

console.log('fill parsing (ledger price fix)');
const noTicker = () => { throw new Error('ticker must not be called'); };
const f1 = parseFill({ action: 'market_order_filled', price: 0.338788, fee: 0.5346, volume: 606.96, order_id: 'P-43' }, 606.96, noTicker);
ok(f1.price === 0.338788 && f1.fee === 0.5346 && f1.size === 606.96 && f1.priceSource === 'fill', 'top-level CLI fill used, ticker not consulted');
const f2 = parseFill({ fills: [{ price: 10, fee: 0.1, size: 2 }] }, 2, noTicker);
ok(f2.price === 10 && f2.fee === 0.1 && f2.size === 2, 'legacy fills[] still supported');
const f3 = parseFill({ order_id: 'x' }, 2, () => 5);
ok(f3.price === 5 && near(f3.fee, 5 * 2 * 0.0026) && f3.priceSource === 'ticker', 'ticker + estimated fee only as last resort');
ok(parseFill({ price: 5, fee: 0, volume: 1 }, 1, noTicker).fee === 0, 'zero fee is respected, not re-estimated');

console.log('reconciliation (orphan / duplicate-buy fix)');
const prices = { 'BTC/USD': 70000, 'ARB/USD': 0.2, 'TRX/USD': 0.34, 'XLM/USD': 0.17 };
const positions = {
  'BTC/USD': { size: 0.001 },
  'ARB/USD': { size: 100 },
  'XLM/USD': { size: 385 },
};
const holdings = {
  'BTC/USD': { total: 0.001 },
  'ARB/USD': { total: 50 },
  'TRX/USD': { total: 606.96 },
  'DOGE/USD': { total: 0.00001 },
};
const d = diffPositions(positions, holdings, { ...prices, 'DOGE/USD': 0.1 });
ok(d.orphans.length === 1 && d.orphans[0].pair === 'TRX/USD', 'untracked holding detected as orphan (TRX case)');
ok(d.gone.length === 1 && d.gone[0] === 'XLM/USD', 'tracked-but-sold position detected as gone (TP filled)');
ok(d.resized.length === 1 && d.resized[0].pair === 'ARB/USD' && d.resized[0].qty === 50, 'size mismatch detected');
ok(!d.orphans.some(o => o.pair === 'DOGE/USD'), 'dust ignored');
const d2 = diffPositions({ 'ETH/USD': { size: 1 } }, { 'ETH/USD': { total: 1 } }, {});
ok(d2.gone.length === 0, 'unpriced position is never assumed gone');
ok(diffPositions(positions, { 'BTC/USD': { total: 0.001 }, 'ARB/USD': { total: 100 }, 'XLM/USD': { total: 385 } }, prices).orphans.length === 0, 'consistent state -> empty diff');

console.log('ledger dedupe');
const recs = [{ symbol: 'TRX/USD', openedAt: '2026-10-27T11:40:07.342Z' }];
ok(ledgerHas(recs, 'TRX/USD', '2026-10-27T11:40:07.342Z'), 'same symbol+openedAt is a duplicate');
ok(!ledgerHas(recs, 'TRX/USD', '2026-10-28T00:00:00.000Z'), 'different openedAt is a new trade');

console.log('freeze sample');
const ledger = [
  { reason: 'bust', ts: '2026-10-28T17:42:00Z', net: -1 },
  { reason: 'stop', ts: '2026-10-27T13:26:00Z', net: -1 },        // old rules
  { reason: 'manual', ts: '2026-10-31T14:20:00Z', net: -0.2 },
  { reason: 'target_fill', ts: '2026-11-02T10:00:00Z', net: 2 },
  { reason: 'stop', ts: '2026-11-03T10:00:00Z', net: -3 },
  { reason: 'timestop', ts: '2026-11-04T10:00:00Z', net: 0.1 },
];
const st2 = strategyTrades(ledger);
ok(st2.length === 3 && st2.every(r => ['target_fill', 'stop', 'timestop'].includes(r.reason)), 'freeze counts only strategy exits since the v1.2 epoch');

console.log('network monitor');
{
  const M = 60_000;
  const good = (ts) => ({ ts, gapS: 50, probeOk: true, cycleOk: true, calls: { n: 6, netFails: 0, p90: 1000 } });
  const run = (net, obs) => netStep(net, obs).net;
  let n = initialNet(0), t = 0;
  for (let i = 0; i < 10; i++) n = run(n, good(t += M));
  ok(n.state === 'OK' && entriesAllowed(n), 'steady good cycles -> OK, entries allowed');

  let r = netStep(n, { ...good(t += M), calls: { n: 6, netFails: 1, p90: 1000 } });
  ok(r.to === 'DEGRADED' && !entriesAllowed(r.net) && /network errors/.test(r.reason), 'one network error -> DEGRADED, entries blocked');
  n = r.net;
  for (let i = 0; i < 4; i++) n = run(n, good(t += M));
  ok(n.state === 'DEGRADED', 'still DEGRADED after 4 good cycles (hysteresis)');
  n = run(n, good(t += M));
  ok(n.state === 'OK', 'back to OK after 5 good cycles');

  ok(netStep(n, { ...good(t + M), calls: { n: 6, netFails: 0, p90: 4000 } }).to === 'DEGRADED', 'slow calls (p90 > 2.5 s) -> DEGRADED');
  ok(netStep(n, { ...good(t + M), gapS: 150 }).to === 'DEGRADED', 'cycle gap > 120 s -> DEGRADED');
  ok(netStep(n, { ...good(t + M), probeOk: false }).to === 'DEGRADED', 'failed probe alone -> DEGRADED');
  ok(netStep(n, { ...good(t + M), gapS: 400 }).to === 'OFFLINE', 'gap > 5 min (signal lost / phone asleep) -> OFFLINE');

  // probe down + 2 failed cycles in a row -> OFFLINE (an hour later, so earlier incidents have expired)
  t += 61 * M;
  let o = netStep(n, { ...good(t += M), probeOk: false, cycleOk: false });
  ok(o.to === 'DEGRADED', 'probe down + 1 failed cycle -> DEGRADED');
  o = netStep(o.net, { ...good(t += M), probeOk: false, cycleOk: false });
  ok(o.to === 'OFFLINE', 'probe down + 2 failed cycles -> OFFLINE');
  o = netStep(o.net, good(t += M));
  ok(o.to === 'DEGRADED', 'first good cycle after OFFLINE -> DEGRADED (not trusted yet)');
  n = o.net;
  for (let i = 0; i < 5; i++) n = run(n, good(t += M));
  ok(n.state === 'OK', 'OFFLINE -> DEGRADED -> OK after 5 good cycles');

  // flapping: 3 incidents within an hour -> INTERMITTENT, sticky for 30 clean minutes
  let f = initialNet(0); t = 0;
  for (let k = 0; k < 3; k++) {
    f = run(f, { ...good(t += M), probeOk: false });
    for (let i = 0; i < 5; i++) f = run(f, good(t += M));
  }
  ok(f.state === 'INTERMITTENT', '3 incidents within an hour -> INTERMITTENT');
  for (let i = 0; i < 10; i++) f = run(f, good(t += M));
  ok(f.state === 'INTERMITTENT' && !entriesAllowed(f), 'INTERMITTENT holds through 10 clean minutes');
  for (let i = 0; i < 25; i++) f = run(f, good(t += M));
  ok(f.state === 'OK', 'INTERMITTENT clears after 30 clean minutes');

  // the 2026-11-01 night: DEGRADED <-> OFFLINE flapping without ever reaching OK
  let fl = initialNet(0); t = 0;
  fl = run(fl, { ...good(t += M), probeOk: false });                 // OK -> DEGRADED (incident 1)
  fl = run(fl, { ...good(t += 7 * M), gapS: 420 });                  // -> OFFLINE (incident 2)
  fl = run(fl, { ...good(t += M), probeOk: false });                 // -> DEGRADED
  const fl3 = netStep(fl, { ...good(t += 7 * M), gapS: 400 });       // -> OFFLINE (incident 3)
  fl = netStep(fl3.net, { ...good(t += M), probeOk: false }).net;    // back online, still flapping
  ok(fl3.net.incidents.length === 3 && fl.state === 'INTERMITTENT', 'DEGRADED <-> OFFLINE flapping counts as incidents -> INTERMITTENT');
  for (let i = 0; i < 26; i++) fl = run(fl, good(t += M));
  ok(fl.state === 'INTERMITTENT' && !entriesAllowed(fl), '27 clean minutes after the last cut: still blocked (the TIA case)');

  ok(isNetworkError('Network error: error sending request for url (https://api.kraken.com/0/public/Ticker)'), 'CLI "Network error" classified as network');
  ok(isNetworkError('', { code: 'ETIMEDOUT' }) && isNetworkError('getaddrinfo EAI_AGAIN api.kraken.com'), 'timeouts and DNS failures classified as network');
  ok(!isNetworkError('EOrder:Insufficient funds'), 'exchange rejections are not network errors');
  ok(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]) === 100 && p90([]) === 0, 'p90 helper');
}

console.log('static guards');
{
  const rs = readFileSync(`${DIR}/runner.mjs`, 'utf8');
  ok(/entriesAllowed\(net\) \? 'auto' : 'noentry'/.test(rs), 'runner blocks entries unless the network is OK');
  ok(/stdio: 'ignore', detached: true/.test(rs) && /SIGKILL/.test(rs), 'phone notification is detached with a hard kill');
}
const runner = readFileSync(`${DIR}/runner.mjs`, 'utf8');
const watchdog = readFileSync(`${DIR}/watchdog.sh`, 'utf8');
const trader = readFileSync(`${DIR}/trader.mjs`, 'utf8');
ok(!/\brequire\(/.test(runner + trader), 'no CommonJS require() in ESM modules (sentinel bug)');
ok(/HALTED/.test(watchdog) && /flock -n/.test(watchdog), 'watchdog respects HALTED and is single-instance');
ok(/HALTED/.test(runner) && /confirmedVerdict/.test(runner), 'runner halts only on a confirmed verdict');
const afterBuy = trader.slice(trader.indexOf('r = buy(sig.pair, size)'));
ok(afterBuy.indexOf('saveState(state)') < afterBuy.indexOf('limitSell('), 'state saved right after a buy, before the TP order');
const entrySrc = trader.slice(trader.indexOf('function entry('), trader.indexOf('// ---- main'));
ok(/inCooldown\(state, pair\)/.test(entrySrc) && /priceDrifted\(/.test(entrySrc), 'entry applies cooldown and price-drift guards');
ok(/lastExit/.test(trader.slice(trader.indexOf('function bookClose'), trader.indexOf('// ---- reconciliation'))), 'every close records lastExit (stop, TP, reconcile)');
ok(/blockedByCorr\(sig\.pair, Object\.keys\(state\.positions\)\)/.test(entrySrc), 'corr checked against positions opened earlier in the same cycle');
ok(!/\/home\/oc/.test(runner + trader + readFileSync(`${DIR}/ctl.mjs`, 'utf8')), 'no hard-coded home paths');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
