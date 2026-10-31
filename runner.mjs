#!/usr/bin/env node
/**
 * Daemon: runs one trader cycle every TICK_MS in a child process, snapshots equity,
 * and stops for good (writing HALTED) on a confirmed PASS/BUST.
 */
import { snapshot, confirmedVerdict, RULES, DIR, HALTED } from './ctl.mjs';
import { appendFileSync, writeFileSync, statSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const LOG = `${DIR}/bot.log`;
const ALERTS = `${DIR}/alerts.log`;
const SENTINEL = `${DIR}/FAILURE_SENTINEL`;
const STATE_FILE = `${DIR}/runner.state.json`;
const TICK_MS = 45_000;
const CYCLE_TIMEOUT_MS = 600_000;
const MAX_FAILURES = 8;
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
function alertLog(msg) { appendFileSync(ALERTS, `${new Date().toISOString()} ${msg}\n`); }
function setRunnerState(o) {
  writeFileSync(STATE_FILE, JSON.stringify({ cycle, ts: new Date().toISOString(), ...o }, null, 2));
}

function runCycle(mode) {
  return new Promise((resolve) => {
    const args = [`${DIR}/trader.mjs`, 'loop', ...(mode === 'noentry' ? ['noentry'] : [])];
    const p = spawn(process.execPath, args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, CYCLE_TIMEOUT_MS);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { /* ignore */ }
      if (timedOut) err = `cycle exceeded ${CYCLE_TIMEOUT_MS / 1000}s — killed`;
      resolve({ code, err: err.trim(), parsed, timedOut });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (existsSync(HALTED)) {
    log('INFO', `HALTED file present (${HALTED}) — not starting. Delete it to resume.`);
    return;
  }
  const mode = process.argv.includes('noentry') ? 'noentry' : 'auto';
  log('INFO', `=== spot paper runner started | mode ${mode} | start $${RULES.start} | target $${RULES.target} | floor $${RULES.floor} ===`);

  while (true) {
    cycle++;
    const { code, err, parsed, timedOut } = await runCycle(mode);

    if (timedOut || ((err || code !== 0) && !parsed) || parsed?.error) {
      failures++;
      const detail = (parsed?.error || err || `exit ${code}`).slice(0, 300);
      log('ERROR', `cycle ${cycle} failed (exit ${code}): ${detail}`);
      setRunnerState({ status: 'ERROR', error: detail });
      try { writeFileSync(SENTINEL, `${new Date().toISOString()} ${detail}\n`); } catch { /* ignore */ }
      if (failures >= MAX_FAILURES) { log('FATAL', 'too many consecutive failures — halting for manual review'); break; }
      await sleep(Math.min(60_000, 15_000 * failures));
      continue;
    }
    failures = 0;
    try { unlinkSync(SENTINEL); } catch { /* none */ }
    if (parsed?.halted) { log('INFO', 'trader reports HALTED — stopping'); break; }

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
      g.source !== 'venue' ? `src=${g.source}${g.rejected != null ? `(venue $${g.rejected.toFixed(2)} rejected)` : ''}` : null,
      parsed?.closed?.length ? `closed=[${parsed.closed.join('; ')}]` : null,
      parsed?.entered?.length ? `entry=[${parsed.entered.join('; ')}]` : null,
      parsed?.near?.length ? `near=[${parsed.near.join(',')}]` : null,
      parsed?.frozen ? 'FROZEN' : null,
    ].filter(Boolean).join(' ');
    log('INFO', line);
    for (const c of parsed?.closed ?? []) alertLog(c);
    setRunnerState({ status: g.status, equity: g.cur, progress: +g.progress.toFixed(2) });

    if (g.status !== 'RUNNING') {
      const cv = confirmedVerdict(g.equity);
      if (cv.verdict === 'RUNNING') {
        log('WARN', `terminal reading not confirmed, ignored: ${JSON.stringify(cv.glitch)}`);
      } else {
        log(cv.verdict, `${cv.verdict === 'PASS' ? '🎉 PASSED' : '💀 GAME OVER'} — equity $${cv.cur.toFixed(2)} (confirmed)`);
        writeFileSync(HALTED, `${new Date().toISOString()} ${cv.verdict} equity=${cv.cur.toFixed(2)}\n`);
        setRunnerState({ status: cv.verdict, equity: cv.cur, final: true });
        break;
      }
    }
    await sleep(TICK_MS);
  }
  log('INFO', '=== runner stopped ===');
}

main().catch((e) => { log('FATAL', e.stack || e.message); process.exit(1); });
