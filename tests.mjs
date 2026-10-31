#!/usr/bin/env node
/**
 * Pure unit tests — no network, no exchange calls. Run: node tests.mjs
 */
import { readFileSync } from 'node:fs';
import { riskFor } from './riskpolicy.mjs';
import { analyse, corrWith, diffPositions, ledgerHas } from './trader.mjs';
import { chooseEquity, ownValuation, holdingsFrom, verdict, confirmedVerdict, DIR } from './ctl.mjs';
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

console.log('verdict');
ok(verdict(1120) === 'PASS' && verdict(970) === 'BUST' && verdict(1000) === 'RUNNING', 'PASS / BUST / RUNNING thresholds');
ok(confirmedVerdict({ cur: 1000 }).verdict === 'RUNNING', 'non-terminal verdict needs no second read');

console.log('signal');
const bars = [];
for (let i = 0; i < 200; i++) { const p = 100 + i; bars.push({ open: p - 0.5, high: p + 1, low: p - 1, close: p }); }
for (let i = 1; i <= 40; i++) { const p = 300 - i; bars.push({ open: p + 0.5, high: p + 1, low: p - 1, close: p }); }
const flat = Array.from({ length: 80 }, () => ({ high: 101, low: 99, close: 100 }));
globalThis.__TEST_BARS__ = { 'TEST/USD': bars, 'TWIN/USD': bars, 'FLAT/USD': flat };
const sig = analyse('TEST/USD');
ok(sig && sig.side === 'long', 'oversold dip in uptrend -> long signal');
ok(sig && sig.stopPx < sig.price && sig.tpPx > sig.price, 'stop < entry < target');
ok(sig && near((sig.tpPx - sig.price) / (sig.price - sig.stopPx), 0.5, 1e-6), 'target = 0.5R (0.75 / 1.5 ATR)');
ok(analyse('FLAT/USD') === null, 'flat / short history -> no signal');
ok(near(corrWith('TEST/USD', 'TWIN/USD'), 1, 1e-9), 'corrWith of identical series = 1 (offline)');

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

console.log('static guards');
const runner = readFileSync(`${DIR}/runner.mjs`, 'utf8');
const watchdog = readFileSync(`${DIR}/watchdog.sh`, 'utf8');
const trader = readFileSync(`${DIR}/trader.mjs`, 'utf8');
ok(!/\brequire\(/.test(runner + trader), 'no CommonJS require() in ESM modules (sentinel bug)');
ok(/HALTED/.test(watchdog) && /flock -n/.test(watchdog), 'watchdog respects HALTED and is single-instance');
ok(/HALTED/.test(runner) && /confirmedVerdict/.test(runner), 'runner halts only on a confirmed verdict');
const afterBuy = trader.slice(trader.indexOf('r = buy(sig.pair, size)'));
ok(afterBuy.indexOf('saveState(state)') < afterBuy.indexOf('limitSell('), 'state saved right after a buy, before the TP order');
ok(!/\/home\/oc/.test(runner + trader + readFileSync(`${DIR}/ctl.mjs`, 'utf8')), 'no hard-coded home paths');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
