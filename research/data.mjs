// Shared data sets for the research scripts (see docs/RESEARCH.md).
//   u24      the 24 live majors (hist.spot.1d.json)
//   other    19 pairs never used for tuning (hist.universe700.1d.json minus u24) + BTC for the regime
//   u43      u24 + other
// Download the history first: node fetch_hist.mjs && node fetch_universe.mjs && node fetch_hist_universe.mjs
import { readFileSync, existsSync } from 'node:fs';

const ROOT = process.env.KS_DIR || new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const load = (f) => {
  const p = `${ROOT}/${f}`;
  if (!existsSync(p)) throw new Error(`missing ${p} — run the fetch_* scripts first`);
  return JSON.parse(readFileSync(p, 'utf8'));
};

export function datasets() {
  const u24 = load('hist.spot.1d.json');
  const u700 = load('hist.universe700.1d.json');
  const other = { 'BTC/USD': u24['BTC/USD'] };
  for (const p of Object.keys(u700)) if (!u24[p]) other[p] = u700[p];
  return { u24, other, u43: { ...u24, ...other } };
}
