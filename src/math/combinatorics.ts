// Log-combinatorics using log-gamma (Lanczos) so large factorials never overflow.

const GAMMA_P: number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function gammaLn(z: number): number {
  if (z < 0.5) {
    return (
      Math.log(Math.PI / Math.sin(Math.PI * z)) - gammaLn(1 - z)
    );
  }
  const x = z - 1;
  let a = GAMMA_P[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) {
    a += GAMMA_P[i]! / (x + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Natural log of n! for integer n >= 0. */
export function logFactorial(n: number): number {
  return gammaLn(n + 1);
}

/** Natural log of binomial coefficient C(n, k); returns -Infinity for impossible choices. */
export function logChoose(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k)) return -Infinity;
  if (k < 0 || k > n || n < 0) return -Infinity;
  if (k === 0 || k === n) return 0;
  const kk = Math.min(k, n - k);
  return logFactorial(n) - logFactorial(kk) - logFactorial(n - kk);
}

/** Exact binomial coefficient for small integers (used by enumerative cross-checks). */
export function chooseBig(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  const kk = Math.min(k, n - k);
  let numerator = 1n;
  let denominator = 1n;
  for (let i = 0; i < kk; i++) {
    numerator *= BigInt(n - i);
    denominator *= BigInt(i + 1);
  }
  return numerator / denominator;
}

/** exp() of a log-sum computed via the log-sum-exp trick for numerical stability. */
export function logSumExp(logs: number[]): number {
  let m = -Infinity;
  for (const v of logs) if (v > m) m = v;
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (const v of logs) s += Math.exp(v - m);
  return m + Math.log(s);
}
