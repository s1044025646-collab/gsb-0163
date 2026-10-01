import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../src/model/plan.js';
import { firstDecision, secondDecision } from '../src/model/decision.js';

test('rejects non-integer and negative fields', () => {
  assert.throws(() => validatePlan({ N: 10 } as never), /integer/);
  assert.throws(
    () => validatePlan({ N: 10, n1: -1, n2: 0, ac1: 0, re1: 1, ac2: 0, re2: 1 }),
    /n1/,
  );
});

test('rejects samples exceeding lot', () => {
  assert.throws(
    () => validatePlan({ N: 10, n1: 12, n2: 0, ac1: 0, re1: 1, ac2: 0, re2: 1 }),
    /SAMPLE_EXCEEDS_LOT|n1/,
  );
  assert.throws(
    () => validatePlan({ N: 10, n1: 6, n2: 6, ac1: 0, re1: 2, ac2: 2, re2: 3 }),
    /n1 \+ n2/,
  );
});

test('rejects illegal thresholds', () => {
  assert.throws(
    () => validatePlan({ N: 50, n1: 10, n2: 10, ac1: 3, re1: 2, ac2: 4, re2: 5 }),
    /re1/,
  );
  assert.throws(
    () => validatePlan({ N: 50, n1: 10, n2: 10, ac1: 1, re1: 3, ac2: 4, re2: 6 }),
    /re2 must equal ac2/,
  );
  assert.throws(
    () => validatePlan({ N: 50, n1: 10, n2: 10, ac1: 1, re1: 3, ac2: 1, re2: 2 }),
    /can still be accepted/,
  );
});

test('zero continue region requires n2=0', () => {
  assert.throws(
    () => validatePlan({ N: 50, n1: 10, n2: 5, ac1: 2, re1: 3, ac2: 2, re2: 3 }),
    /degenerate/,
  );
  const p = validatePlan({ N: 50, n1: 10, n2: 0, ac1: 2, re1: 3, ac2: 2, re2: 3 });
  assert.equal(p.n2, 0);
});

test('impossible observations are rejected', () => {
  const plan = validatePlan({ N: 20, n1: 8, n2: 12, ac1: 1, re1: 4, ac2: 5, re2: 6 });
  assert.throws(() => firstDecision(plan, 9), /d1 exceed/);
  // d1=3 continue, but trueK=6 => remaining has 3 defectives in 12; n2=12 => d2 must equal 3
  assert.throws(() => secondDecision(plan, 3, 2, 6), /infeasible/);
  assert.doesNotThrow(() => secondDecision(plan, 3, 3, 6));
});

test('stage-one final lot cannot be rewritten by stage two', () => {
  const plan = validatePlan({ N: 100, n1: 20, n2: 30, ac1: 1, re1: 4, ac2: 4, re2: 5 });
  assert.throws(() => secondDecision(plan, 0, 3), (e: any) => e.code === 'DECISION_FINAL');
  assert.throws(() => secondDecision(plan, 4, 0), (e: any) => e.code === 'DECISION_FINAL');
});
