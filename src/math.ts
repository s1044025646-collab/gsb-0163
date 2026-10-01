/**
 * Hypergeometric / double-sampling mathematics.
 * All probabilities use log-factorials + exp() so no large factorials overflow.
 * Sampling is WITHOUT replacement; round two is conditioned on the exact
 * good/defective counts removed in round one (never independent binomials).
 */

const logFactCache: number[] = [0];

export function logFact(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`logFact: bad n=${n}`);
  for (let i = logFactCache.length; i <= n; i++) {
    logFactCache[i] = logFactCache[i - 1] + Math.log(i);
  }
  return logFactCache[n];
}

export function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFact(n) - logFact(k) - logFact(n - k);
}

export function choose(n: number, k: number): number {
  const v = logChoose(n, k);
  return v === -Infinity ? 0 : Math.round(Math.exp(v));
}

/** P(X = k), X ~ Hypergeometric(N, K, n): population N with K successes, draw n without replacement. */
export function hypergeomPmf(N: number, K: number, n: number, k: number): number {
  if (k < 0 || k > n || k > K || n - k > N - K) return 0;
  const lp = logChoose(K, k) + logChoose(N - K, n - k) - logChoose(N, n);
  return Math.exp(lp);
}

/** P(X <= k) for X ~ Hypergeometric(N, K, n). */
export function hypergeomCdf(N: number, K: number, n: number, k: number): number {
  const lo = Math.max(0, n - (N - K));
  const hi = Math.min(k, n, K);
  let s = 0;
  for (let i = lo; i <= hi; i++) s += hypergeomPmf(N, K, n, i);
  return Math.min(1, s);
}

export interface DoubleSamplingPlan {
  lotSize: number;
  n1: number;
  n2: number;
  ac1: number;
  re1: number;
  ac2: number;
  re2: number; // must equal ac2 + 1
}

export interface PlanValidation {
  ok: boolean;
  errors: string[];
  /** true when the continue interval (ac1, re1) is empty -> single sampling */
  degenerate: boolean;
}

export function validatePlan(p: DoubleSamplingPlan): PlanValidation {
  const errors: string[] = [];
  const ints: Array<[string, number]> = [
    ['lotSize', p.lotSize], ['n1', p.n1], ['n2', p.n2],
    ['ac1', p.ac1], ['re1', p.re1], ['ac2', p.ac2], ['re2', p.re2],
  ];
  for (const [name, v] of ints) {
    if (!Number.isInteger(v)) errors.push(`${name} must be an integer, got ${v}`);
  }
  if (errors.length) return { ok: false, errors, degenerate: false };

  if (p.lotSize < 1) errors.push('lotSize must be >= 1');
  if (p.n1 < 1) errors.push('n1 must be >= 1');
  if (p.n2 < 0) errors.push('n2 must be >= 0');
  if (p.n1 + p.n2 > p.lotSize) errors.push(`n1+n2 (${p.n1 + p.n2}) exceeds lotSize (${p.lotSize})`);
  if (p.ac1 < 0) errors.push('ac1 must be >= 0');
  if (p.re1 <= p.ac1) errors.push('re1 must be > ac1');
  if (p.re1 > p.n1 + 1) errors.push(`re1 (${p.re1}) > n1+1: round-1 rejection can never trigger`);
  if (p.ac1 > p.n1) errors.push(`ac1 (${p.ac1}) > n1: round-1 acceptance can never trigger`);
  if (p.ac2 < p.ac1) errors.push('ac2 must be >= ac1');
  if (p.re2 !== p.ac2 + 1) errors.push('re2 must equal ac2 + 1 (decision must be exhaustive after round 2)');
  if (p.n2 === 0 && p.re1 > p.ac1 + 1) errors.push('n2 = 0 requires an empty continue interval (re1 = ac1 + 1)');
  if (p.ac2 > p.n1 + p.n2) errors.push(`ac2 (${p.ac2}) > n1+n2: cumulative acceptance unreachable`);
  const degenerate = p.re1 === p.ac1 + 1;
  return { ok: errors.length === 0, errors, degenerate };
}

export interface CurvePoint {
  defectives: number;
  pAccept: number;
  pAcceptRound1: number;
  pRejectRound1: number;
  pContinue: number;
  asn: number; // average sample number
}

/**
 * Evaluate a double-sampling plan for a lot with exactly `defectives` defectives.
 * Round two conditions on round-one outcome x1: remaining population N-n1 with
 * D-x1 defectives, X2 ~ Hypergeometric(N-n1, D-x1, n2).
 */
export function evaluatePlan(p: DoubleSamplingPlan, defectives: number): CurvePoint {
  const v = validatePlan(p);
  if (!v.ok) throw new RangeError(`invalid plan: ${v.errors.join('; ')}`);
  const N = p.lotSize;
  const D = defectives;
  if (!Number.isInteger(D) || D < 0 || D > N) {
    throw new RangeError(`defectives must be an integer in [0, ${N}], got ${defectives}`);
  }

  const x1Lo = Math.max(0, p.n1 - (N - D));
  const x1Hi = Math.min(p.n1, D);

  let pAcceptRound1 = 0;
  let pRejectRound1 = 0;
  let pContinue = 0;
  let pAcceptRound2 = 0;

  for (let x1 = x1Lo; x1 <= x1Hi; x1++) {
    const px1 = hypergeomPmf(N, D, p.n1, x1);
    if (x1 <= p.ac1) {
      pAcceptRound1 += px1;
    } else if (x1 >= p.re1) {
      pRejectRound1 += px1;
    } else {
      pContinue += px1;
      const remN = N - p.n1;
      const remD = D - x1;
      const need = p.ac2 - x1; // accept overall if X2 <= need
      if (need >= 0) {
        pAcceptRound2 += px1 * hypergeomCdf(remN, remD, p.n2, need);
      }
    }
  }

  return {
    defectives: D,
    pAccept: pAcceptRound1 + pAcceptRound2,
    pAcceptRound1,
    pRejectRound1,
    pContinue,
    asn: p.n1 + p.n2 * pContinue,
  };
}

/** Scan D in [dMin, dMax] to build the OC curve. */
export function ocCurve(p: DoubleSamplingPlan, dMin = 0, dMax = p.lotSize): CurvePoint[] {
  if (!Number.isInteger(dMin) || !Number.isInteger(dMax) || dMin < 0 || dMax > p.lotSize || dMin > dMax) {
    throw new RangeError(`bad scan range [${dMin}, ${dMax}] for lotSize ${p.lotSize}`);
  }
  const out: CurvePoint[] = [];
  for (let d = dMin; d <= dMax; d++) out.push(evaluatePlan(p, d));
  return out;
}

export const PROPORTION_MAPPING_DOC =
  'Proportions p in (0,1) map to integer defectives via D = round(p * lotSize), clamped to [0, lotSize]; integers >= 1 are absolute counts.';

/**
 * Map a proportion (AQL/LQL as a fraction) to an integer defective count.
 * DISCLOSED MAPPING: D = round(p * N), clamped to [0, N].
 * Integers >= 1 pass through as absolute defective counts.
 */
export function proportionToDefectives(pOrCount: number, lotSize: number): number {
  if (typeof pOrCount !== 'number' || Number.isNaN(pOrCount) || pOrCount < 0) {
    throw new RangeError(`bad proportion/count: ${pOrCount}`);
  }
  if (pOrCount > 0 && pOrCount < 1) {
    return Math.min(lotSize, Math.max(0, Math.round(pOrCount * lotSize)));
  }
  if (!Number.isInteger(pOrCount)) {
    throw new RangeError(`absolute defective count must be an integer, got ${pOrCount}`);
  }
  if (pOrCount > lotSize) throw new RangeError(`count ${pOrCount} exceeds lotSize ${lotSize}`);
  return pOrCount;
}

export interface RiskPair {
  aqlInput: number;
  lqlInput: number;
  aqlDefectives: number;
  lqlDefectives: number;
  producerRisk: number; // alpha = 1 - Pa(D_aql)
  consumerRisk: number; // beta  = Pa(D_lql)
  mapping: string;
}

export function compareRisks(p: DoubleSamplingPlan, aql: number, lql: number): RiskPair {
  const dAql = proportionToDefectives(aql, p.lotSize);
  const dLql = proportionToDefectives(lql, p.lotSize);
  if (dLql < dAql) throw new RangeError(`LQL defectives (${dLql}) < AQL defectives (${dAql})`);
  const paAql = evaluatePlan(p, dAql).pAccept;
  const paLql = evaluatePlan(p, dLql).pAccept;
  return {
    aqlInput: aql,
    lqlInput: lql,
    aqlDefectives: dAql,
    lqlDefectives: dLql,
    producerRisk: 1 - paAql,
    consumerRisk: paLql,
    mapping: PROPORTION_MAPPING_DOC,
  };
}
