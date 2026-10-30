#!/usr/bin/env node
import { snapshot, RULES, DIR } from './ctl.mjs';
import { appendFileSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';

const LOG = `${DIR}/bot.log`;
const TICK_MS = 45_000;
const STATE_FILE = `${DIR}/runner.state.json`;
let cycle = 0;
let failures = 0;

function rotateIfNeeded(file, maxBytes = 5 * 1024 * 1024) {
  try { if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`); } catch { /* missing */ }
}
function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  rotateIfNeeded(LOG);
  appendFileSync(LOG, line + '\n');
  console.log(line);
}
function setRunnerState(o) {
  writeFileSync(STATE_FILE, JSON.stringify({ cycle, ts: new Date().toISOString(), ...o }, null, 2));
}
const CYCLE_TIMEOUT_MS = 600_000;
function runCycle(mode) {
  return new Promise((resolve) => {
    const args = mode === 'noentry'
      ? [`${DIR}/trader.mjs`, 'loop', 'noentry']
      : [`${DIR}/trader.mjs`, 'loop'];
    const p = spawn('node', args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { err = `cycle exceeded ${CYCLE_TIMEOUT_MS/1000}s — killed`; p.kill('SIGKILL'); }, CYCLE_TIMEOUT_MS);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { /* ignore */ }
      resolve({ code, out, err: err.trim(), parsed });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log('INFO', `=== spot paper runner started | start $${RULES.start} | target $${RULES.target} (+12%) | floor $${RULES.floor} (-3%) | spot paper, long-only, screening ===`);

  while (true) {
    cycle++;
    const runMode = process.argv.includes('noentry') ? 'noentry' : 'auto';
const { code, out, err, parsed } = await runCycle(runMode);

    if (((err || code !== 0) && !parsed) || parsed?.error) {
      failures++;
      const detail = (parsed?.error || err || `exit ${code}`).slice(0, 300);
      log('ERROR', `cycle ${cycle} failed (exit ${code}): ${detail}`);
      setRunnerState({ status: 'ERROR', error: detail });
      if (failures >= 8) { log('FATAL', 'too many consecutive failures — halting for manual review'); break; }
      // sentinel
      try { writeFileSync(`${DIR}/FAILURE_SENTINEL`, `${new Date().toISOString()} ${detail}\n`); } catch {}
      await sleep(Math.min(60_000, 15_000 * failures));
      continue;
    }
    failures = 0;
    try { require('node:fs').unlinkSync(`${DIR}/FAILURE_SENTINEL`); } catch {}

    let g;
    try { g = snapshot('runner'); }
    catch (e) {
      log('WARN', `snapshot failed (will retry): ${String(e.message).slice(0, 200)}`);
      setRunnerState({ status: 'RUNNING', equity: null, progress: null });
      await sleep(TICK_MS);
      continue;
    }
    const line = [
      `eq=$${g.cur.toFixed(2)}`,
      `pnl=${g.pnl >= 0 ? '+' : ''}${g.pnl.toFixed(2)}%`,
      `prog=${g.progress.toFixed(1)}%`,
      `pos=${parsed?.positions ?? 0}`,
      parsed?.closed?.length ? `closed=[${parsed.closed.join('; ')}]` : null,
      parsed?.entered?.length ? `entry=[${parsed.entered.join('; ')}]` : null,
      parsed?.near ? `near=[${parsed.near.join(',')}]` : null,
    ].filter(Boolean).join(' ');
    log('INFO', line);
    if (parsed?.closed?.length) {
      for (const c of parsed.closed) alertLog(c);
    }
    setRunnerState({ status: g.status, equity: g.cur, progress: +g.progress.toFixed(2) });

    if (g.status === 'PASS') {
      log('PASS', `🎉 PASSED — equity $${g.cur.toFixed(2)}`);
      setRunnerState({ status: 'PASS', equity: g.cur, final: true });
      break;
    }
    if (g.status === 'BUST') {
      log('BUST', `💀 GAME OVER — equity $${g.cur.toFixed(2)}`);
      setRunnerState({ status: 'BUST', equity: g.cur, final: true });
      break;
    }
    await sleep(TICK_MS);
  }
  log('INFO', '=== runner stopped ===');
}

function alertLog(msg) {
  appendFileSync(`${DIR}/alerts.log`, `${new Date().toISOString()} ${msg}\n`);
}

main().catch((e) => { log('FATAL', e.stack || e.message); process.exit(1); });
