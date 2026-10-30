/**
 * Spot-paper execution helpers.
 */
import { kraken, lastPrice } from './ctl.mjs';

export const FEE = 0.0026;

/** Market buy. Returns {price, fee, size, orderId, status}. */
export function buy(pair, size) {
  const r = kraken(['paper', 'buy', pair, String(size), '--type', 'market', '-o', 'json']);
  // spot paper may not return fills; price from ticker fallback
  const fill = (r.fills ?? [])[0] ?? {};
  const price = Number(fill.price) || lastPrice(pair);
  return { price, fee: Number(fill.fee ?? (price * size * FEE)), size: Number(fill.size ?? size),
           orderId: r.order_id ?? r.id ?? null, status: r.status ?? r.result ?? 'ok', raw: r };
}

/** Market sell. */
export function sell(pair, size) {
  const r = kraken(['paper', 'sell', pair, String(size), '--type', 'market', '-o', 'json']);
  const fill = (r.fills ?? [])[0] ?? {};
  const price = Number(fill.price) || lastPrice(pair);
  return { price, fee: Number(fill.fee ?? (price * size * FEE)), size: Number(fill.size ?? size),
           orderId: r.order_id ?? r.id ?? null, status: r.status ?? r.result ?? 'ok', raw: r };
}

/** Limit sell (take-profit resting). */
export function limitSell(pair, size, price) {
  return kraken(['paper', 'sell', pair, String(size), '--type', 'limit', '--price', String(price), '-o', 'json'], { allowFail: true });
}

/** Cancel an order by id. */
export function cancel(orderId) {
  if (!orderId) return null;
  return kraken(['paper', 'cancel', String(orderId), '-o', 'json'], { allowFail: true });
}

/** Cancel all open orders. */
export function cancelAll() {
  return kraken(['paper', 'cancel-all', '-o', 'json'], { allowFail: true });
}

export const positions = () => null; // spot has no positions endpoint; derived from state + balance
