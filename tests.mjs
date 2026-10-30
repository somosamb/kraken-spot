import { riskFor } from './riskpolicy.mjs';
import { analyse, corrWith } from './trader.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// ladder
for (const eq of [975, 990, 1000, 1050, 1119]) {
  const r = riskFor(eq);
  // a single loss (riskFor) must be <= 20% of cushion above floor
  const cushion = eq - 970;
  ok(r <= 0.2 * cushion + 1e-9, `ladder: risk $${r.toFixed(2)} <= 20% of cushion at $${eq}`);
}
ok(riskFor(970) === 0, 'risk 0 at floor');

// constants
// (smoke: analyse exists)
ok(typeof analyse === 'function', 'analyse exported');

// geometry with injected bars
const bars = [];
for (let i = 0; i < 200; i++) {           // long uptrend (price > EMA200)
  const price = 100 + i;
  bars.push({ open: price - 0.5, high: price + 1, low: price - 1, close: price });
}
for (let i = 1; i <= 40; i++) {           // recent dip below EMA20, still above EMA200
  const price = 300 - i;
  bars.push({ open: price + 0.5, high: price + 1, low: price - 1, close: price });
}
const lastBarX = bars[bars.length-1];     // green candle
lastBarX.open = lastBarX.close - 0.5;
globalThis.__TEST_BARS__ = { 'TEST/USD': bars };
const sig = analyse('TEST/USD');
ok(sig && sig.side === 'long', 'oversold dip -> long signal');
if (sig) {
  ok(sig.stopPx < sig.price, 'stop below entry for long');
  ok(sig.tpPx > sig.price, 'target above entry for long');
  ok(sig.tpPx - sig.price >= 0.5 * (sig.price - sig.stopPx) * 0.9, 'target >= ~0.5R (0.75/1.5 ATR)');
}

// mid-range no signal
const bars2 = [];
for (let i = 0; i < 80; i++) bars2.push({ high: 101, low: 99, close: 100 });
globalThis.__TEST_BARS__['FLAT/USD'] = bars2;
const sig2 = analyse('FLAT/USD');
ok(sig2 === null, 'flat market -> no signal');

// corrWith (smoke)
const c = corrWith('BTC/USD', 'ETH/USD');
ok(Number.isFinite(c), 'corrWith finite');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
