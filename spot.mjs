/**
 * Spot-paper execution helpers.
 */
import { kraken, lastPrice, FEE_PER_SIDE } from './ctl.mjs';

export const FEE = FEE_PER_SIDE;

/**
 * Normalise a market-order response. The CLI reports the fill at the top level
 * (`price`, `fee`, `volume`); older builds used `fills[]`. The ticker is only a last resort.
 * Pure (fallback injected), unit-tested.
 */
export function parseFill(r, size, fallbackPrice) {
  const fill = (r?.fills ?? [])[0] ?? {};
  const price = Number(r?.price) || Number(fill.price) || fallbackPrice();
  const vol = Number(r?.volume) || Number(fill.size ?? fill.volume) || Number(size);
  const feeRaw = r?.fee ?? fill.fee;
  const fee = Number.isFinite(Number(feeRaw)) && feeRaw !== null && feeRaw !== undefined
    ? Number(feeRaw)
    : price * vol * FEE;
  return {
    price, fee, size: vol,
    orderId: r?.order_id ?? r?.id ?? null,
    status: r?.action ?? r?.status ?? 'ok',
    priceSource: Number(r?.price) || Number(fill.price) ? 'fill' : 'ticker',
    raw: r,
  };
}

/** Market buy. */
export function buy(pair, size) {
  const r = kraken(['paper', 'buy', pair, String(size), '--type', 'market', '-o', 'json']);
  return parseFill(r, size, () => lastPrice(pair));
}

/** Market sell. */
export function sell(pair, size) {
  const r = kraken(['paper', 'sell', pair, String(size), '--type', 'market', '-o', 'json']);
  return parseFill(r, size, () => lastPrice(pair));
}

/** Limit sell (resting take-profit). Returns the order id or null. */
export function limitSell(pair, size, price) {
  const r = kraken(['paper', 'sell', pair, String(size), '--type', 'limit', '--price', String(price), '-o', 'json'], { allowFail: true });
  return r ? (r.order_id ?? r.id ?? null) : null;
}

/** Cancel an order by id (positional argument). */
export function cancel(orderId) {
  if (!orderId) return null;
  return kraken(['paper', 'cancel', String(orderId), '-o', 'json'], { allowFail: true });
}

/** Cancel every open order on one pair (never touches other symbols). */
export function cancelPair(pair, openOrders) {
  const norm = (p) => String(p ?? '').replace('/', '');
  let n = 0;
  for (const o of openOrders ?? []) {
    if (norm(o.pair ?? o.symbol) === norm(pair)) { cancel(o.order_id ?? o.id); n++; }
  }
  return n;
}
