#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const DIR = '/home/oc/kraken-spot';
const UNIVERSE = ['BTC/USD','ETH/USD','SOL/USD','XRP/USD','ADA/USD','DOGE/USD','LINK/USD','AVAX/USD','DOT/USD','LTC/USD','BCH/USD','UNI/USD','ATOM/USD','NEAR/USD','APT/USD','ARB/USD','OP/USD','SUI/USD','INJ/USD','TIA/USD','TRX/USD','XLM/USD','ETC/USD','FIL/USD'];

function ohlc(pair) {
  const out = execFileSync('/home/oc/bin/kraken', ['ohlc', pair, '--interval', '1440', '-o', 'json'], { encoding: 'utf8', maxBuffer: 32*1024*1024 });
  const j = JSON.parse(out.trim().split('\n').pop());
  return (j.candles || []).map(c => ({ time:+c.time, open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+c.volume }));
}

const hist = {};
for (const p of UNIVERSE) {
  process.stderr.write(`fetching ${p}...\n`);
  try { hist[p] = ohlc(p); }
  catch (e) { console.error(`fail ${p}: ${e.message}`); hist[p] = []; }
}
writeFileSync(`${DIR}/hist.spot.1d.json`, JSON.stringify(hist));
console.log('saved', Object.keys(hist).length, 'series');
const lens = Object.values(hist).map(v=>v.length);
console.log('min/max len', Math.min(...lens), Math.max(...lens));
