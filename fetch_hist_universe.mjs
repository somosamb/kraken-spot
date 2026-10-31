#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const DIR = process.env.KS_DIR || new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const KRAKEN = process.env.KRAKEN_BIN || 'kraken';
const universe = JSON.parse(readFileSync(`${DIR}/universe.json`, 'utf8'));
const pairs = universe.selected.map(s => s.pair);
const hist = {};
for (const p of pairs) {
  process.stderr.write(`fetching ${p}...\n`);
  try {
    const out = execFileSync(KRAKEN, ['ohlc', p, '--interval', '1440', '-o', 'json'], { encoding: 'utf8', maxBuffer: 32*1024*1024 });
    const j = JSON.parse(out.trim().split('\n').pop());
    const bars = (j.candles || []).map(c => ({ time:+c.time, open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+c.volume }));
    if (bars.length >= 200) hist[p] = bars;
    else process.stderr.write(`  skip ${p}: only ${bars.length} bars\n`);
  } catch (e) {
    process.stderr.write(`  fail ${p}: ${e.message.slice(0,80)}\n`);
  }
}
writeFileSync(`${DIR}/hist.universe.1d.json`, JSON.stringify(hist));
console.log('saved', Object.keys(hist).length, 'series');
const lens = Object.values(hist).map(v=>v.length);
console.log('min/max len', Math.min(...lens), Math.max(...lens));
