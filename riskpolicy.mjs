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

export function scaledRiskFor(equity) {
  return +Math.min(riskFor(equity) * ratchetFor(equity), PORTFOLIO_CAP).toFixed(4);
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
