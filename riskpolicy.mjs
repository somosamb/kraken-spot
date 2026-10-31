export const FLOOR = 970, START = 1000, KNEE = 1045, TARGET = 1120;
export const RISK_MAX = 20;
export const RISK_KNEE = 7;
export const PORTFOLIO_CAP = 75;
// Conditional ratchet (sweep 2026-10-28): 1x below $1015, 1.5x from $1015, 2x from the knee.
export const RATCHET_STEPS = [
  { at: 1015, mult: 1.5 },
  { at: KNEE, mult: 2 },
];
export function ratchetFor(equity) {
  let mult = 1;
  for (const s of RATCHET_STEPS) if (equity >= s.at) mult = s.mult;
  return mult;
}
export const FEE_PER_SIDE = 0.0026;

export function riskFor(equity) {
  if (!Number.isFinite(equity) || equity <= FLOOR) return 0;
  if (equity >= TARGET) return RISK_MAX;
  if (equity <= KNEE) {
    const slope = RISK_KNEE / (KNEE - FLOOR);
    return +Math.min(RISK_KNEE, slope * (equity - FLOOR)).toFixed(4);
  }
  const slope = (RISK_MAX - RISK_KNEE) / (TARGET - KNEE);
  return +Math.min(RISK_MAX, RISK_KNEE + slope * (equity - KNEE)).toFixed(4);
}

/**
 * Global multiplier on the ladder (v1.2: ×3). Research 2026-10-31 (docs/RESEARCH.md):
 * with the ATR ≥ 3% screen, ×3 gave 9/48 PASS and 0 BUST on the 24 majors even with
 * worst-case stop fills — but from a single bull episode, median ~445 days to PASS.
 * Because the ladder sizes each loss as a fraction of the remaining cushion, losing
 * streaks alone cannot reach the floor; the residual risk is stop slippage.
 */
export const RISK_MULT = 3;

export function scaledRiskFor(equity) {
  return +Math.min(riskFor(equity) * ratchetFor(equity) * RISK_MULT, PORTFOLIO_CAP).toFixed(4);
}

export function openRisk(pos) {
  if (!pos?.entry || !pos?.stopPx || !pos?.size) return 0;
  return Math.abs(pos.entry - pos.stopPx) * pos.size;
}

export function budgetFor(equity, state) {
  const policy = scaledRiskFor(equity);
  let used = 0;
  for (const p of Object.values(state?.positions ?? {})) used += openRisk(p);
  const room = Math.max(0, PORTFOLIO_CAP - used);
  return {
    policy,
    used: +used.toFixed(4),
    room: +room.toFixed(4),
    allowed: +Math.min(policy, room).toFixed(4),
    cappedByPolicy: room < policy,
  };
}
