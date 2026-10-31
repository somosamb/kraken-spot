#!/usr/bin/env node
/**
 * Live consistency check: code parses, processes are single, local state matches the
 * exchange (positions, take-profits), equity sources agree. Exit 0 = consistent.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import {
  DIR, HALTED, RULES, status, balance, paperOrders, holdingsFrom, lastPrices, ownValuation,
  chooseEquity, loadState,
} from './ctl.mjs';
import { diffPositions } from './trader.mjs';

let pass = 0, fail = 0, warn = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  ' + d : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`); };
const note = (n, d = '') => { warn++; console.log(`  WARN  ${n}${d ? '  ' + d : ''}`); };
const chk = (c, n, d = '') => (c ? ok(n, d) : bad(n, d));

console.log(`\n=== VALIDATION  ${new Date().toISOString()} ===\n`);

console.log('[1] code parses');
for (const f of ['ctl.mjs', 'spot.mjs', 'trader.mjs', 'runner.mjs', 'riskpolicy.mjs', 'validate.mjs', 'tests.mjs']) {
  try { execFileSync(process.execPath, ['--check', `${DIR}/${f}`]); ok(`${f} parses`); }
  catch (e) { bad(`${f} parses`, e.message.slice(0, 80)); }
}
for (const f of ['watchdog.sh', 'kspot', 'resume.sh', 'killprocs.sh']) {
  try { execFileSync('sh', ['-n', `${DIR}/${f}`]); ok(`${f} parses`); }
  catch (e) { bad(`${f} parses`, e.message.slice(0, 80)); }
}

console.log('\n[2] processes');
const count = (re) => {
  try { return Number(execFileSync('pgrep', ['-fc', re]).toString().trim()); } catch { return 0; }
};
const runners = count('^node runner\\.mjs');
const watchdogs = count('^(/bin/)?sh (\\./)?watchdog\\.sh$');
const halted = existsSync(HALTED);
chk(runners <= 1, 'at most one runner', String(runners));
chk(watchdogs <= 1, 'at most one watchdog', String(watchdogs));
if (halted) note('HALTED present', readFileSync(HALTED, 'utf8').trim());
else {
  chk(runners === 1, 'runner alive');
  chk(watchdogs === 1, 'watchdog alive');
}
if (existsSync(`${DIR}/FAILURE_SENTINEL`)) note('FAILURE_SENTINEL present', readFileSync(`${DIR}/FAILURE_SENTINEL`, 'utf8').trim());

console.log('\n[3] equity');
const st = status();
const bal = balance();
chk(!!bal, 'balance readable');
const holdings = holdingsFrom(bal);
const prices = lastPrices([...new Set([...Object.keys(holdings), ...Object.keys(loadState().positions)])]);
const own = ownValuation(bal, prices);
const eq = chooseEquity(st, own);
chk(st.valuation_complete !== false, 'venue valuation complete');
chk(eq.source === 'venue', 'venue and own valuation agree', `venue=${Number(st.current_value).toFixed(2)} own=${own?.toFixed(2)}`);
chk(eq.cur > RULES.floor, 'equity above floor', `cushion $${(eq.cur - RULES.floor).toFixed(2)}`);

console.log('\n[4] state vs exchange');
const state = loadState();
const d = diffPositions(state.positions, holdings, prices);
chk(d.orphans.length === 0, 'no untracked holdings', d.orphans.map(o => `${o.pair}:${o.qty}`).join(' '));
chk(d.gone.length === 0, 'no tracked positions missing on exchange', d.gone.join(' '));
chk(d.resized.length === 0, 'tracked sizes match holdings', d.resized.map(o => `${o.pair}:${o.qty}`).join(' '));
chk(Object.keys(state.positions).length <= 2, 'positions <= MAX_CONCURRENT');
const oo = paperOrders();
const openIds = new Set((oo?.open_orders ?? oo?.orders ?? []).map(o => o.id ?? o.order_id));
for (const [pair, p] of Object.entries(state.positions)) {
  chk(p.tpOrderId && openIds.has(p.tpOrderId), `${pair} take-profit resting`, String(p.tpOrderId));
  chk(p.stopPx < p.entry && p.tpPx > p.entry, `${pair} stop < entry < tp`);
}
chk(!existsSync(`${DIR}/state.json.tmp`), 'no leftover state.json.tmp');

console.log('\n[5] ledger');
const recs = existsSync(`${DIR}/trades.jsonl`)
  ? readFileSync(`${DIR}/trades.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const keys = recs.map(r => `${r.symbol}|${r.openedAt}`);
chk(new Set(keys).size === keys.length, 'no duplicate trades in ledger', `${recs.length} trades`);

console.log(`\n=== ${pass} passed, ${fail} failed, ${warn} warnings ===`);
console.log(fail === 0 ? 'SYSTEM CONSISTENT' : 'INCONSISTENCIES FOUND');
process.exit(fail === 0 ? 0 : 1);
