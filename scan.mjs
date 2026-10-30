import { ohlc } from './ctl.mjs';
const UNIVERSE = ['BTC/USD','ETH/USD','SOL/USD','XRP/USD','ADA/USD','DOGE/USD','LINK/USD','AVAX/USD','DOT/USD','LTC/USD','BCH/USD','UNI/USD','ATOM/USD','NEAR/USD','APT/USD','ARB/USD','OP/USD','SUI/USD','INJ/USD','TIA/USD','TRX/USD','XLM/USD','ETC/USD','FIL/USD'];
function ema(v,p){const k=2/(p+1);let e=v[0];const o=[];for(let i=0;i<v.length;i++){e=i===0?v[0]:v[i]*k+e*(1-k);o.push(e);}return o;}
function atr(b,p=14){const w=b.slice(-p-1);if(w.length<p+1)return 0;let s=0;for(let i=1;i<w.length;i++)s+=Math.max(w[i].high-w[i].low,Math.abs(w[i].high-w[i-1].close),Math.abs(w[i].low-w[i-1].close));return s/(w.length-1);}
const rows=[];
for(const p of UNIVERSE){
  try{
    const r=ohlc(p,60);
    const bars=(r.candles||[]).filter(c=>Number(c.time)<Number(r.last)).map(c=>({high:+c.high,low:+c.low,close:+c.close,open:+c.open}));
    if(bars.length<30) continue;
    const closes=bars.map(b=>b.close);
    const a=atr(bars,14);
    const e20=ema(closes,20).at(-1);
    const price=closes.at(-1);
    const extDown=(e20-price)/a;
    const last=bars[bars.length-1];
    const green=last.close>last.open;
    const cc=closes.slice(-15);
    let g=0,l=0; for(let j=1;j<cc.length;j++){const d=cc[j]-cc[j-1]; if(d>0)g+=d; else l-=d;}
    const rsi=l===0?100:100-100/(1+g/l);
    rows.push({p,ext:extDown,rsi,green,price});
  }catch(e){}
}
rows.sort((a,b)=>b.ext-a.ext);
for(const r of rows.slice(0,8)) console.log(`${r.p.padEnd(10)} ext=${r.ext.toFixed(2)} rsi=${r.rsi.toFixed(1)} green=${r.green} price=${r.price.toFixed(4)}`);
