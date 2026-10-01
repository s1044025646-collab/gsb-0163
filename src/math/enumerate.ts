import { chooseBig } from './combinatorics.js';
import type { DoublePlan } from '../model/plan.js';
import { isDegenerate } from '../model/plan.js';

/**
 * Exact acceptance probability for small lots by enumerating every way the
 * ordered two-stage (without-replacement) sample can unfold, counting
 * favorable combinations with exact bigint binomial coefficients.
 *
 * The physical sample of n1+n2 units is equivalent to choosing n1 first-stage
 * units then n2 second-stage units from the remainder; joint weight for a
 * split with d1 then d2 defectives is
 *   C(K,d1) C(N-K,n1-d1) [stage1 population]
 *   C(K-d1,d2) C(N-K-(n1-d1),n2-d2) [stage2 population]
 * divided by C(N,n1) C(N-n1,n2).
 */
export function exactAcceptance(plan: DoublePlan, K: number): number {
  const { N, n1, n2, ac1, re1, ac2 } = plan;
  if (n1 + n2 > 60)
    throw new RangeError('enumeration only supported for n1+n2 <= 60');

  const totalWays = chooseBig(N, n1) * chooseBig(N - n1, n2);
  let acceptWays = 0n;

  const l1 = Math.max(0, n1 + K - N);
  const h1 = Math.min(n1, K);
  for (let d1 = l1; d1 <= h1; d1++) {
    const w1 = chooseBig(K, d1) * chooseBig(N - K, n1 - d1);
    if (d1 <= ac1) {
      acceptWays += w1 * chooseBig(N - n1, n2);
      continue;
    }
    if (d1 >= re1) continue; // rejected; second stage never drawn
    if (isDegenerate(plan)) continue;
    const remainLot = N - n1;
    const remainDef = K - d1;
    const l2 = Math.max(0, n2 + remainDef - remainLot);
    const h2 = Math.min(n2, remainDef);
    for (let d2 = l2; d2 <= h2; d2++) {
      if (d1 + d2 > ac2) continue;
      const w2 =
        chooseBig(remainDef, d2) *
        chooseBig(remainLot - remainDef, n2 - d2);
      acceptWays += w1 * w2;
    }
  }

  return Number(acceptWays * 1000000000n / totalWays) / 1000000000;
}

/** Exact expected sample size via the same combinatoric enumeration. */
export function exactAsn(plan: DoublePlan, K: number): number {
  if (isDegenerate(plan)) return plan.n1;
  const { N, n1, n2, ac1, re1 } = plan;
  const totalWays = chooseBig(N, n1) * chooseBig(N - n1, n2);
  let continueWays = 0n;
  const l1 = Math.max(0, n1 + K - N);
  const h1 = Math.min(n1, K);
  for (let d1 = l1; d1 <= h1; d1++) {
    if (d1 <= ac1 || d1 >= re1) continue;
    continueWays +=
      chooseBig(K, d1) *
      chooseBig(N - K, n1 - d1) *
      chooseBig(N - n1, n2);
  }
  const pCont = Number(continueWays * 1000000000n / totalWays) / 1000000000;
  return n1 + n2 * pCont;
}
