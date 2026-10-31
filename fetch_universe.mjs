#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const KRAKEN = process.env.KRAKEN_BIN || 'kraken';
const DIR = process.env.KS_DIR || new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const STABLES = new Set(['USDT','USDC','DAI','BUSD','TUSD','USD','EUR','GBP','AUD','CAD','CHF','JPY','PYUSD','FDUSD','USDD','USDP']);
const pairsRaw = execFileSync(KRAKEN, ['pairs', '-o', 'json'], { encoding: 'utf8', maxBuffer: 64*1024*1024 });
const pairs = JSON.parse(pairsRaw.trim().split('\n').pop());
const usdPairs = Object.keys(pairs).filter(p => p.endsWith('/USD') && !STABLES.has(p.split('/')[0]));

// chunk tickers
const chunkSize = 60;
const volMap = {};
for (let i = 0; i < usdPairs.length; i += chunkSize) {
  const chunk = usdPairs.slice(i, i + chunkSize);
  process.stderr.write(`ticker chunk ${i}/${usdPairs.length}\n`);
  try {
    const out = execFileSync(KRAKEN, ['ticker', ...chunk, '-o', 'json'], { encoding: 'utf8', maxBuffer: 64*1024*1024 });
    const j = JSON.parse(out.trim().split('\n').pop());
    for (const [p, t] of Object.entries(j)) {
      const vol = Number(t.volume_24h ?? 0) * Number(t.last_price ?? 0);
      volMap[p] = vol;
    }
  } catch (e) {
    process.stderr.write(`chunk fail: ${e.message.slice(0,120)}\n`);
  }
}
const ranked = Object.entries(volMap).sort((a,b) => b[1]-a[1]);
const topN = 50;
const selected = ranked.slice(0, topN).map(([p, v]) => ({ pair: p, usdVol24h: Math.round(v) }));
writeFileSync(`${DIR}/universe.json`, JSON.stringify({ ranked: ranked.map(([p,v])=>({pair:p,usdVol24h:Math.round(v)})), selected }, null, 2));
console.log('top 20:');
for (const s of selected.slice(0,20)) console.log(s.pair, s.usdVol24h);
console.log('selected', selected.length);
