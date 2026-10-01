import { logChoose } from './combinatorics.js';

export interface HyperParams {
  N: number; // lot size
  K: number; // number of defectives in lot
  n: number; // sample size (without replacement)
}

export function validateHyper(p: HyperParams): void {
  const { N, K, n } = p;
  if (![N, K, n].every(Number.isInteger) || N < 1 || K < 0 || n < 0) {
    throw new RangeError('N,K,n must be integers with N>=1, K>=0, n>=0');
  }
  if (K > N) throw new RangeError('defectives K cannot exceed lot size N');
  if (n > N) throw new RangeError('sample n cannot exceed remaining lot size N');
}

/** Support [lo, hi] of the hypergeometric defective count. */
export function hyperSupport(p: HyperParams): [number, number] {
  const { N, K, n } = p;
  const lo = Math.max(0, n + K - N);
  const hi = Math.min(n, K);
  return [lo, hi];
}

/** log P(X = k) for X ~ Hypergeometric(N, K, n). */
export function logHyperPmf(p: HyperParams, k: number): number {
  const { N, K, n } = p;
  if (!Number.isInteger(k)) return -Infinity;
  const [lo, hi] = hyperSupport(p);
  if (k < lo || k > hi) return -Infinity;
  return (
    logChoose(K, k) +
    logChoose(N - K, n - k) -
    logChoose(N, n)
  );
}

export function hyperPmf(p: HyperParams, k: number): number {
  return Math.exp(logHyperPmf(p, k));
}

/** P(a <= X <= b). */
export function hyperInterval(p: HyperParams, a: number, b: number): number {
  const [lo, hi] = hyperSupport(p);
  const start = Math.max(a, lo);
  const end = Math.min(b, hi);
  let s = 0;
  for (let k = start; k <= end; k++) s += hyperPmf(p, k);
  return s;
}

/** Stable recursion of the pmf across support, anchored at the mode. */
export function hyperDistribution(p: HyperParams): Map<number, number> {
  validateHyper(p);
  const { N, K, n } = p;
  const [lo, hi] = hyperSupport(p);
  const map = new Map<number, number>();
  if (n === 0) {
    map.set(0, 1);
    return map;
  }
  // Mode of hypergeometric.
  const mode = Math.floor(((n + 1) * (K + 1)) / (N + 2));
  const anchor = Math.min(hi, Math.max(lo, mode));
  map.set(anchor, Math.exp(logHyperPmf(p, anchor)));
  // Ratio P(k-1)/P(k) = k(N-K-n+k)/((K-k+1)(n-k+1))
  for (let k = anchor; k > lo; k--) {
    const prev =
      (map.get(k)! * k * (N - K - n + k)) /
      ((K - k + 1) * (n - k + 1));
    map.set(k - 1, prev);
  }
  // Ratio P(k+1)/P(k) = (n-k)(K-k)/((k+1)(N-K-n+k+1))
  for (let k = anchor; k < hi; k++) {
    const next =
      (map.get(k)! * (n - k) * (K - k)) /
      ((k + 1) * (N - K - n + k + 1));
    map.set(k + 1, next);
  }
  return map;
}
