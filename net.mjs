/**
 * Connectivity health monitor — pure state machine (no I/O), unit-tested.
 *
 * The bot runs on a phone; mobile signal can be slow, intermittent or absent. Managing open
 * positions is always allowed (the software stop needs every cycle it can get), but opening
 * new ones is only allowed while the link is healthy.
 *
 *   OK            healthy: normal operation
 *   DEGRADED      recent network failure, slow calls, a failed probe or a long cycle gap
 *   INTERMITTENT  repeated incidents within an hour — like DEGRADED, but needs a long clean
 *                 period before returning to OK
 *   OFFLINE       exchange unreachable, or no cycle for a long time (signal lost, phone asleep)
 *
 * Each runner loop feeds one observation:
 *   { ts, gapS, probeOk, cycleOk, calls: { n, netFails, p90 } }
 * gapS     seconds since the previous cycle started (normal ≈ 50 s)
 * probeOk  direct HTTPS probe to the Kraken API succeeded
 * cycleOk  the previous trader cycle completed
 * calls    CLI call stats of the previous cycle (netFails = network-type failures only)
 */
export const NET = {
  SLOW_P90_MS: 2500,             // normal CLI call ≈ 0.9 s
  GAP_DEGRADED_S: 120,           // normal cadence ≈ 50 s
  GAP_OFFLINE_S: 300,
  OFFLINE_FAILED_CYCLES: 2,      // probe down + this many failed cycles in a row = OFFLINE
  RECOVER_CYCLES: 5,             // consecutive good cycles to return to OK (hysteresis)
  FLAP_WINDOW_MS: 60 * 60_000,   // incidents counted over the last hour…
  FLAP_INCIDENTS: 3,             // …this many make the link INTERMITTENT
  INTERMITTENT_CLEAN_MS: 30 * 60_000,
};

export const entriesAllowed = (net) => net?.state === 'OK';

export function initialNet(ts = Date.now()) {
  return { state: 'OK', since: ts, goodStreak: 0, failStreak: 0, lastBadTs: null, incidents: [] };
}

/** Classify one observation: 'good' | 'bad' | 'offline'. */
export function classify(obs, failStreak = 0, P = NET) {
  const calls = obs.calls ?? {};
  const failedNow = obs.cycleOk === false ? failStreak + 1 : 0;
  if (obs.gapS > P.GAP_OFFLINE_S) return 'offline';
  if (!obs.probeOk && failedNow >= P.OFFLINE_FAILED_CYCLES) return 'offline';
  if (!obs.probeOk || obs.cycleOk === false || (calls.netFails ?? 0) > 0
      || (calls.p90 ?? 0) > P.SLOW_P90_MS || obs.gapS > P.GAP_DEGRADED_S) return 'bad';
  return 'good';
}

/**
 * Advance the state machine by one observation.
 * Returns { net, from, to, changed, reason }.
 */
export function step(prev, obs, P = NET) {
  const net = { ...prev, incidents: (prev.incidents ?? []).filter(t => obs.ts - t <= P.FLAP_WINDOW_MS) };
  const cls = classify(obs, prev.failStreak, P);
  net.failStreak = obs.cycleOk === false ? prev.failStreak + 1 : 0;
  const from = prev.state;
  let to = from;

  if (cls === 'good') {
    net.goodStreak = prev.goodStreak + 1;
    if (from === 'OFFLINE') to = 'DEGRADED';                        // back online, not yet trusted
    if (from !== 'OK' && net.goodStreak >= P.RECOVER_CYCLES) {
      const clean = net.lastBadTs === null || obs.ts - net.lastBadTs >= P.INTERMITTENT_CLEAN_MS;
      if (from !== 'INTERMITTENT' || clean) to = 'OK';
    }
  } else {
    net.goodStreak = 0;
    net.lastBadTs = obs.ts;
    // an incident = any worsening: leaving OK, or dropping to OFFLINE from a better state.
    // (Counting only OK exits missed a night of DEGRADED <-> OFFLINE flapping, 2026-11-01.)
    if (from === 'OK' || (cls === 'offline' && from !== 'OFFLINE')) net.incidents.push(obs.ts);
    const flapping = net.incidents.length >= P.FLAP_INCIDENTS;
    if (cls === 'offline') to = 'OFFLINE';
    else if (flapping || from === 'INTERMITTENT') to = 'INTERMITTENT';
    else if (from === 'OK' || from === 'OFFLINE') to = 'DEGRADED';
  }
  // recovering from OFFLINE while flapping goes to INTERMITTENT, not DEGRADED
  if (from === 'OFFLINE' && to === 'DEGRADED' && net.incidents.length >= P.FLAP_INCIDENTS) to = 'INTERMITTENT';

  const changed = to !== from;
  if (changed) net.since = obs.ts;
  net.state = to;
  const calls = obs.calls ?? {};
  const reason = cls === 'good' ? `good x${net.goodStreak}`
    : [obs.gapS > P.GAP_DEGRADED_S && `gap ${Math.round(obs.gapS)}s`,
       !obs.probeOk && 'probe failed',
       obs.cycleOk === false && 'cycle failed',
       (calls.netFails ?? 0) > 0 && `${calls.netFails} network errors`,
       (calls.p90 ?? 0) > P.SLOW_P90_MS && `p90 ${(calls.p90 / 1000).toFixed(1)}s`,
       net.incidents.length >= P.FLAP_INCIDENTS && `${net.incidents.length} incidents/h`,
      ].filter(Boolean).join(', ');
  return { net, from, to, changed, reason, cls };
}

/** p90 of a list of durations (ms). */
export function p90(ms) {
  if (!ms.length) return 0;
  const s = [...ms].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.9 * s.length))];
}
