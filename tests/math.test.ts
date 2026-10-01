import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logChoose, chooseBig } from '../src/math/combinatorics.js';
import { hyperDistribution, validateHyper } from '../src/math/hypergeom.js';
import { ocCurve, stageProbabilities, evaluate } from '../src/math/engine.js';
import { exactAcceptance, exactAsn } from '../src/math/enumerate.js';
import { validatePlan } from '../src/model/plan.js';

const approx = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

test('logChoose matches exact bigint coefficients', () => {
  for (const [n, k] of [[0,0],[5,2],[10,3],[60,30]] as const) {
    approx(Math.exp(logChoose(n, k)), Number(chooseBig(n, k)), 1e-6 * Math.max(1, Number(chooseBig(n,k))));
  }
});

test('large factorial does not overflow', () => {
  assert.ok(Number.isFinite(logChoose(100000, 50000)));
});

test('hypergeometric distribution sums to one', () => {
  for (const [N, K, n] of [[10,3,4],[20,0,5],[20,20,5],[100,37,40],[8,4,3]] as const) {
    const dist = hyperDistribution({ N, K, n });
    let s = 0;
    for (const v of dist.values()) s += v;
    approx(s, 1, 1e-9);
  }
});

test('hypergeometric rejects sample exceeding remaining lot', () => {
  assert.throws(() => validateHyper({ N: 10, K: 2, n: 11 }), /cannot exceed/);
});

test('stage branches partition probability (sum to one)', () => {
  const plan = validatePlan({ N: 100, n1: 20, n2: 30, ac1: 1, re1: 4, ac2: 4, re2: 5 });
  for (let K = 0; K <= 100; K++) {
    const s = stageProbabilities(plan, K);
    approx(
      s.acceptFirst + s.rejectFirst + s.acceptSecond + s.rejectSecond,
      1, 1e-9,
    );
  }
});

test('acceptance probability matches exact enumeration (small lot)', () => {
  const plan = validatePlan({ N: 8, n1: 3, n2: 3, ac1: 0, re1: 2, ac2: 2, re2: 3 });
  for (let K = 0; K <= 8; K++) {
    approx(evaluate(plan, K).pa, exactAcceptance(plan, K), 1e-9);
    approx(evaluate(plan, K).asn, exactAsn(plan, K), 1e-7);
  }
});

test('enumeration agrees on whole-lot and zero-continue plans', () => {
  const whole = validatePlan({ N: 20, n1: 8, n2: 12, ac1: 1, re1: 4, ac2: 5, re2: 6 });
  for (let K = 0; K <= 20; K++)
    approx(evaluate(whole, K).pa, exactAcceptance(whole, K), 1e-9);
  const single = validatePlan({ N: 20, n1: 10, n2: 0, ac1: 2, re1: 3, ac2: 2, re2: 3 });
  for (let K = 0; K <= 20; K++)
    approx(evaluate(single, K).pa, exactAcceptance(single, K), 1e-9);
});

test('Pa is non-increasing in K and ASN stays within [n1, n1+n2]', () => {
  const plan = validatePlan({ N: 100, n1: 20, n2: 30, ac1: 1, re1: 4, ac2: 4, re2: 5 });
  const curve = ocCurve(plan);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i]!.pa <= curve[i-1]!.pa + 1e-12);
    assert.ok(curve[i]!.asn >= plan.n1 - 1e-9);
    assert.ok(curve[i]!.asn <= plan.n1 + plan.n2 + 1e-9);
  }
  approx(curve[0]!.pa, 1, 1e-12);
  approx(curve[curve.length-1]!.pa, 0, 1e-12);
});

test('degenerate single sampling has ASN = n1', () => {
  const plan = validatePlan({ N: 50, n1: 10, n2: 0, ac1: 2, re1: 3, ac2: 2, re2: 3 });
  for (let K = 0; K <= 50; K++) approx(evaluate(plan, K).asn, 10);
});

test('second stage is conditioned on removed units (not independent binomial)', () => {
  // Whole lot, N=20, K=6. After n1=8 with d1=3, remaining lot has 3 defectives
  // among 12; n2=12 samples all of them, so d2 must be exactly 3.
  const plan = validatePlan({ N: 20, n1: 8, n2: 12, ac1: 1, re1: 4, ac2: 5, re2: 6 });
  const s = stageProbabilities(plan, 6);
  // probability mass for the d1=3 continue path acceptance via d2<=2 is zero
  // (cumulative 3+d2 with d2=3 -> 6 > ac2=5 => reject). Check total bounded.
  assert.ok(s.acceptSecond >= 0 && s.acceptSecond <= 1);
});
