/**
 * Decimal-string money arithmetic.
 *
 * Prices in this product are strings (`"0"`, `"0.1"`, `"25"` — `PRICE_RE` in `@ngram/core`) and the money contract
 * compares a quoted total with what the agent restated by STRING EQUALITY (design §6.1). Parsing those strings into
 * JS numbers would make `0.1 + 0.2` a budget decision, so every sum, comparison and cap check here runs on scaled
 * BigInts and comes back as a canonical string.
 */
export const SCALE = 9n;
const POW = 10n ** SCALE;

export class AmountError extends Error {}

/** `"25"` / `"0.1"` → scaled BigInt. Throws on anything that is not a non-negative decimal. */
export function parseAmount(v: string | number, label = 'amount'): bigint {
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new AmountError(`${label} must be a non-negative number (e.g. "0", "0.1", "25"), got ${JSON.stringify(String(v))}`);
  const [int = '0', frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE));
  return BigInt(int) * POW + BigInt(padded || '0');
}

/** Scaled BigInt → the canonical string form (no trailing zeros, no trailing dot). */
export function formatAmount(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const int = abs / POW;
  const frac = (abs % POW).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

export const addAmounts = (...v: (string | number)[]): string => formatAmount(v.reduce<bigint>((a, x) => a + parseAmount(x), 0n));
export const subAmounts = (a: string | number, b: string | number): string => formatAmount(parseAmount(a) - parseAmount(b));
/** -1 | 0 | 1 */
export const cmpAmounts = (a: string | number, b: string | number): number => { const x = parseAmount(a); const y = parseAmount(b); return x < y ? -1 : x > y ? 1 : 0; };
/** The canonical form of one amount — what a quote publishes and what `confirm_total` is compared against. */
export const normalizeAmount = (v: string | number, label = 'amount'): string => formatAmount(parseAmount(v, label));
export const isZero = (v: string | number): boolean => parseAmount(v) === 0n;
