#!/usr/bin/env node
/**
 * Daemon: runs one trader cycle every TICK_MS in a child process, snapshots equity,
 * and stops for good (writing HALTED) on a confirmed PASS/BUST.
 */
// Same DNS fix as the CLI (see ctl.mjs CLI_ENV): some routers drop one of the two queries
// glibc sends together, and the 5 s retry equals the probe timeout, so the probe failed
// falsely. glibc reads RES_OPTIONS on its first lookup, so it must be set before any fetch.
process.env.RES_OPTIONS ??= 'single-request-reopen';
import { snapshot, confirmedVerdict, RULES, DIR, HALTED, takeCallStats } from './ctl.mjs';
import { initialNet, step as netStep, entriesAllowed, callStats, slowCycle, NET } from './net.mjs';
import { appendFileSync, writeFileSync, readFileSync, statSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const LOG = `${DIR}/bot.log`;
const ALERTS = `${DIR}/alerts.log`;
const SENTINEL = `${DIR}/FAILURE_SENTINEL`;
const STATE_FILE = `${DIR}/runner.state.json`;
const TICK_MS = +(process.env.KS_TICK_MS || 45_000);          // override only for tests
const MAX_CYCLES = +(process.env.KS_MAX_CYCLES || Infinity);   // test hook: stop after N cycles
const CYCLE_TIMEOUT_MS = 600_000;
const MAX_FAILURES = 8;
const NET_FILE = `${DIR}/net.state.json`;
const NET_RESET = `${DIR}/NET_RESET`;        // `npm run net:reset`: manual return to OK
const PROBE_URL = 'https://api.kraken.com/0/public/Time';
const PROBE_TIMEOUT_MS = 5000;
const NOTIFY = process.env.KS_NOTIFY !== '0';      // phone notification on network state changes
const PROBE_EVERY = 10;                            // heartbeat probe every N cycles even when healthy
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

/** Direct HTTPS probe to the Kraken API, independent of the CLI. */
async function probe() {
  const t = Date.now();
  try {
    const r = await fetch(PROBE_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { ok: r.ok, ms: Date.now() - t };
  } catch { return { ok: false, ms: Date.now() - t }; }
}

/**
 * Phone notification (Termux). Fire-and-forget: it can take seconds or hang, so it runs
 * detached with a hard kill after 20 s and can never block a cycle. Missing binary = no-op.
 */
function notify(title, content) {
  if (!NOTIFY) return;
  try {
    const p = spawn('termux-notification', ['--id', '7700', '--title', title, '--content', content],
      { stdio: 'ignore', detached: true });
    p.on('error', () => { /* not on Termux */ });
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 20_000);
    t.unref();
    p.on('exit', () => clearTimeout(t));
    p.unref();
  } catch { /* diagnostics only */ }
}

function loadNet() {
  try { return JSON.parse(readFileSync(NET_FILE, 'utf8')).net ?? initialNet(); } catch { return initialNet(); }
}
function lastRunnerTs() {
  try { return Date.parse(JSON.parse(readFileSync(STATE_FILE, 'utf8')).ts); } catch { return NaN; }
}

async function main() {
  if (existsSync(HALTED)) {
    log('INFO', `HALTED file present (${HALTED}) — not starting. Delete it to resume.`);
    return;
  }
  const mode = process.argv.includes('noentry') ? 'noentry' : 'auto';
  log('INFO', `=== spot paper runner started | mode ${mode} | start $${RULES.start} | target $${RULES.target} | floor $${RULES.floor} ===`);

  let net = loadNet();
  let prevStart = lastRunnerTs();        // first gap covers any downtime before this start
  let lastCycleOk = true;
  let lastTraderNet = null;
  let lastProbeMs = null;

  while (cycle < MAX_CYCLES) {
    cycle++;
    const t0 = Date.now();

    // ---- connectivity health: decide whether this cycle may open new positions ----
    if (existsSync(NET_RESET)) {
      // manual override (e.g. "I'm on good wifi now"): start from a clean OK state; the
      // monitor still degrades again on the next bad cycle
      try { unlinkSync(NET_RESET); } catch { /* raced */ }
      const msg = `NET ${net.state} -> OK (manual reset); entries enabled`;
      net = initialNet(t0);
      prevStart = t0; lastCycleOk = true; lastTraderNet = null; takeCallStats();
      log('INFO', msg);
      alertLog(msg);
    }
    // The probe costs a request every cycle; only run it when something looks wrong
    // (state not OK, failed/slow cycle, network errors, long gap) or as a periodic heartbeat.
    const gapNow = Number.isFinite(prevStart) ? (t0 - prevStart) / 1000 : 0;
    const lastStats = callStats(lastTraderNet?.ms ?? [], lastTraderNet?.netFails ?? 0);
    const needProbe = net.state !== 'OK' || !lastCycleOk || lastStats.netFails > 0 || slowCycle(lastStats)
      || gapNow > NET.GAP_DEGRADED_S || cycle % PROBE_EVERY === 1;
    const pr = needProbe ? await probe() : { ok: true, ms: null, skipped: true };
    if (!pr.skipped) lastProbeMs = pr.ms;
    const own = takeCallStats();         // runner's own CLI calls (snapshot) from the last loop
    const ms = [...(lastTraderNet?.ms ?? []), ...own.ms];
    const obs = {
      ts: t0,
      gapS: Number.isFinite(prevStart) ? (t0 - prevStart) / 1000 : 0,
      probeOk: pr.ok,
      cycleOk: lastCycleOk,
      calls: callStats(ms, (lastTraderNet?.netFails ?? 0) + own.netFails),
    };
    prevStart = t0;
    const offlineSince = net.state === 'OFFLINE' ? net.since : null;
    const st = netStep(net, obs);
    net = st.net;
    try { writeFileSync(NET_FILE, JSON.stringify({ net, lastObs: obs, reason: st.reason, probeMs: lastProbeMs, probeSkipped: !!pr.skipped }, null, 2)); } catch { /* ignore */ }
    if (st.changed) {
      const away = offlineSince ? ` after ${Math.round((t0 - offlineSince) / 60000)} min offline` : '';
      const msg = `NET ${st.from} -> ${st.to} (${st.reason})${away}; entries ${entriesAllowed(net) ? 'enabled' : 'blocked'}`;
      log(st.to === 'OK' ? 'INFO' : 'WARN', msg);
      alertLog(msg);
      notify(`kraken-spot: red ${st.to}`,
        `${st.reason}${away}. ${entriesAllowed(net) ? 'Entradas reactivadas.' : 'Entradas bloqueadas; posiciones gestionadas.'}`);
    }
    const runMode = mode === 'auto' && entriesAllowed(net) ? 'auto' : 'noentry';

    const { code, err, parsed, timedOut } = await runCycle(runMode);
    const cycleSec = Math.round((Date.now() - t0) / 1000);
    lastTraderNet = parsed?.net ?? null;

    lastCycleOk = !(timedOut || ((err || code !== 0) && !parsed) || parsed?.error);
    if (!lastCycleOk) {
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
    try { g = snapshot('runner', parsed?.equity); }   // reuse the trader's reading: no extra CLI calls
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
      `cyc=${cycleSec}s`,
      `net=${net.state}${runMode !== mode ? '(noentry)' : ''}`,
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
