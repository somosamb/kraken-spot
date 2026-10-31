#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { simulate } from './backtest.mjs';
const DIR = process.env.KS_DIR || new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const hist = JSON.parse(readFileSync(`${DIR}/hist.spot.1d.json`, 'utf8'));
const UNIVERSE = Object.keys(hist);
const N = hist[UNIVERSE[0]].length;
const BLOCK = 180;
const numBlocks = Math.floor(N / BLOCK);

const variants = [
  { K:1.2, MAX_CONCURRENT:2, CORR_MAX:0.65, HOLD_MAX_DAYS:5 },
  { K:1.2, MAX_CONCURRENT:4, CORR_MAX:0.65, HOLD_MAX_DAYS:5 },
  { K:1.2, MAX_CONCURRENT:4, CORR_MAX:1.0,  HOLD_MAX_DAYS:5 },
  { K:1.0, MAX_CONCURRENT:4, CORR_MAX:1.0,  HOLD_MAX_DAYS:5 },
  { K:1.5, MAX_CONCURRENT:2, CORR_MAX:0.65, HOLD_MAX_DAYS:5 },
];

for (const strategy of ['dip','breakout']) {
  console.log(`\n========== ${strategy.toUpperCase()} ==========`);
  for (const v of variants) {
    let passCount=0, bustCount=0, totalEntries=0, worstOverall=1000;
    for (let b=0;b<numBlocks;b++) {
      const start=b*BLOCK, end=start+BLOCK;
      const blockBars={};
      for (const p of UNIVERSE) blockBars[p]=hist[p].slice(start,end);
      const r = simulate(strategy, blockBars, v);
      if (r.passed) passCount++;
      if (r.busted) bustCount++;
      totalEntries += r.entries;
      if (r.worstEq < worstOverall) worstOverall = r.worstEq;
    }
    console.log(`K=${v.K} slots=${v.MAX_CONCURRENT} corr=${v.CORR_MAX} | PASS ${passCount}/${numBlocks} BUST ${bustCount}/${numBlocks} entries ${totalEntries} worstEq $${worstOverall.toFixed(0)}`);
  }
}
