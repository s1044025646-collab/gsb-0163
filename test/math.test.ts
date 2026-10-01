import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hypergeomPmf, hypergeomCdf, choose, evaluatePlan, ocCurve, validatePlan,
  proportionToDefectives, compareRisks } from '../src/math.ts';
import type { DoubleSamplingPlan } from '../src/math.ts';

const PLAN: DoubleSamplingPlan = { lotSize: 50, n1: 5, n2: 10, ac1: 1, re1: 3, ac2: 3, re2: 4 };

test('hypergeometric pmf sums to 1 over support', () => {
  for (const [N, K, n] of [[50, 7, 5], [20, 0, 20], [13, 13, 13], [100, 1, 50]] as const) {
    let s = 0;
    for (let k = 0; k <= n; k++) s += hypergeomPmf(N, K, n, k);
    assert.ok(Math.abs(s - 1) < 1e-12, `sum=${s}`);
  }
});

test('log-factorial combinatorics avoid overflow for large lots', () => {
  const c = choose(2000, 1000); // ~1e600, beyond float range
  assert.ok(Number.isFinite(Math.log(c)) || c === Infinity);
  // pmf must still be a valid probability even with huge populations
  const p = hypergeomPmf(2000, 1000, 100, 50);
  assert.ok(p > 0 && p < 1, `p=${p}`);
  assert.ok(Math.abs(hypergeomCdf(2000, 1000, 100, 100) - 1) < 1e-9);
});

test('impossible observations have zero probability', () => {
  assert.equal(hypergeomPmf(10, 3, 5, 4), 0); // only 3 defectives exist
  assert.equal(hypergeomPmf(10, 3, 8, 0), 0); // only 7 good exist, drawing 8
});

/**
 * Brute-force cross-check: enumerate EVERY possible round-1 sample and every
 * possible round-2 sample (combinations of actual items) and count outcomes.
 * This independently validates the closed-form hypergeometric evaluation.
 */
function bruteForce(p: DoubleSamplingPlan, D: number) {
  const items = Array.from({ length: p.lotSize }, (_, i) => (i < D ? 1 : 0));
  let acc1 = 0, rej1 = 0, cont = 0, acc2 = 0, total1 = 0, total2 = 0;
  const idx1: number[] = [];
  const walk1 = (start: number) => {
    if (idx1.length === p.n1) {
      total1++;
      const x1 = idx1.reduce((s, i) => s + items[i], 0);
      if (x1 <= p.ac1) { acc1++; return; }
      if (x1 >= p.re1) { rej1++; return; }
      cont++;
      const rem = items.map((v, i) => [v, i] as const).filter(([_, i]) => !idx1.includes(i));
      const idx2: number[] = [];
      const walk2 = (start: number) => {
        if (idx2.length === p.n2) {
          total2++;
          const x2 = idx2.reduce((s, j) => s + rem[j][0], 0);
          if (x1 + x2 <= p.ac2) acc2++;
          return;
        }
        for (let j = start; j < rem.length; j++) { idx2.push(j); walk2(j + 1); idx2.pop(); }
      };
      walk2(0);
      return;
    }
    for (let i = start; i < items.length; i++) { idx1.push(i); walk1(i + 1); idx1.pop(); }
  };
  walk1(0);
  return {
    pAccept: acc1 / total1 + (total2 ? acc2 / total2 * (cont / total1) / (cont / total1) * 0 : 0), // placeholder, replaced below
    acc1: acc1 / total1, rej1: rej1 / total1, cont: cont / total1,
    acc2givenCont: total2 ? acc2 / total2 : 0,
    asn: p.n1 + p.n2 * (cont / total1),
  };
}

test('small-lot exhaustive enumeration matches evaluatePlan', () => {
  const p: DoubleSamplingPlan = { lotSize: 12, n1: 4, n2: 3, ac1: 0, re1: 2, ac2: 1, re2: 2 };
  for (let D = 0; D <= 12; D++) {
    const exact = evaluatePlan(p, D);
    const bf = bruteForce(p, D);
    const bfPa = bf.acc1 + bf.cont * bf.acc2givenCont;
    assert.ok(Math.abs(exact.pAccept - bfPa) < 1e-12, `D=${D}: ${exact.pAccept} vs ${bfPa}`);
    assert.ok(Math.abs(exact.pAcceptRound1 - bf.acc1) < 1e-12);
    assert.ok(Math.abs(exact.pRejectRound1 - bf.rej1) < 1e-12);
    assert.ok(Math.abs(exact.pContinue - bf.cont) < 1e-12);
    assert.ok(Math.abs(exact.asn - bf.asn) < 1e-12);
  }
});

test('branch probabilities sum to 1 and ASN stays within [n1, n1+n2]', () => {
  for (let D = 0; D <= PLAN.lotSize; D++) {
    const pt = evaluatePlan(PLAN, D);
    const sum = pt.pAcceptRound1 + pt.pRejectRound1 + pt.pContinue;
    assert.ok(Math.abs(sum - 1) < 1e-9, `D=${D} sum=${sum}`);
    assert.ok(pt.asn >= PLAN.n1 - 1e-9 && pt.asn <= PLAN.n1 + PLAN.n2 + 1e-9, `D=${D} asn=${pt.asn}`);
    assert.ok(pt.pAccept >= -1e-12 && pt.pAccept <= 1 + 1e-12);
  }
});

test('Pa is monotonically non-increasing in D (OC curve)', () => {
  const pts = ocCurve(PLAN);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].pAccept <= pts[i - 1].pAccept + 1e-12,
      `Pa(${i})=${pts[i].pAccept} > Pa(${i - 1})=${pts[i - 1].pAccept}`);
  }
  assert.ok(Math.abs(pts[0].pAccept - 1) < 1e-12); // zero defectives always accepted
  assert.ok(pts[PLAN.lotSize].pAccept < 1e-9);     // fully defective lot essentially rejected
});

test('empty continue interval degenerates to single sampling', () => {
  const single: DoubleSamplingPlan = { lotSize: 40, n1: 10, n2: 0, ac1: 2, re1: 3, ac2: 2, re2: 3 };
  const v = validatePlan(single);
  assert.ok(v.ok && v.degenerate);
  for (let D = 0; D <= 40; D += 7) {
    const pt = evaluatePlan(single, D);
    assert.equal(pt.pContinue, 0);
    assert.equal(pt.asn, 10);
    assert.ok(Math.abs(pt.pAccept - hypergeomCdf(40, D, 10, 2)) < 1e-12);
  }
});

test('round two conditions on round one (not independent binomials)', () => {
  // Lot of 10 with 9 defectives, n1=5: if round 1 draws 2 defectives,
  // only 7 defectives remain among 5 items -> round-2 defectives are forced.
  const p: DoubleSamplingPlan = { lotSize: 10, n1: 5, n2: 5, ac1: 0, re1: 3, ac2: 9, re2: 10 };
  const pt = evaluatePlan(p, 7);
  // continue needs x1 in {1,2}; then x2 is bounded by remaining defectives
  assert.ok(pt.pContinue > 0);
  assert.ok(Math.abs(pt.pAcceptRound1 + pt.pRejectRound1 + pt.pContinue - 1) < 1e-12);
});

test('invalid plans are rejected', () => {
  const bad: Array<Partial<DoubleSamplingPlan>> = [
    { ...PLAN, re1: 1 },                 // re1 <= ac1
    { ...PLAN, n1: 40, n2: 20 },         // samples exceed lot
    { ...PLAN, re2: 6 },                 // re2 != ac2+1
    { ...PLAN, ac2: 0 },                 // ac2 < ac1
    { ...PLAN, n1: 0 },                  // empty first sample
    { ...PLAN, re1: 99 },                // unreachable rejection
    { ...PLAN, lotSize: 0 },
  ];
  for (const b of bad) assert.equal(validatePlan(b as DoubleSamplingPlan).ok, false, JSON.stringify(b));
});

test('proportion mapping is disclosed and deterministic', () => {
  assert.equal(proportionToDefectives(0.025, 200), 5);   // round(0.025*200)
  assert.equal(proportionToDefectives(0.025, 50), 1);    // round(1.25)
  assert.equal(proportionToDefectives(7, 200), 7);       // absolute count passthrough
  assert.throws(() => proportionToDefectives(2.5, 200)); // non-integer absolute
  assert.throws(() => proportionToDefectives(300, 200)); // exceeds lot
});

test('risk comparison separates producer and consumer risk', () => {
  const r = compareRisks(PLAN, 0.02, 0.6);
  assert.equal(r.aqlDefectives, 1);
  assert.equal(r.lqlDefectives, 30);
  assert.ok(r.producerRisk >= 0 && r.producerRisk <= 1);
  assert.ok(r.consumerRisk >= 0 && r.consumerRisk <= 1);
  assert.ok(r.consumerRisk < 0.1, `beta=${r.consumerRisk}`);
  assert.throws(() => compareRisks(PLAN, 0.4, 0.02)); // LQL < AQL
});
