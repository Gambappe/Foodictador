// Unit tests for the pure merge logic behind `workstream-lock.mjs add-tasks`.
// Run: node --test scripts/workstream-lock.test.mjs
// Pattern: node:test, no deps, pure functions only — nothing here touches git or the
// registry branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeSeedTasks, UsageError } from './workstream-lock.mjs';

const NOW = '2026-07-25T12:00:00.000Z';

function doneTask(overrides = {}) {
  return {
    title: 'existing',
    phase: 'P0',
    depends_on: [],
    mock_start_ok: false,
    note: null,
    status: 'done',
    owner: null,
    branch: null,
    pr: null,
    claimed_at: null,
    updated_at: '2026-07-24T09:35:00Z',
    ...overrides,
  };
}

function registry() {
  return {
    schema_version: 1,
    tasks: { 'T0.1': doneTask(), 'T0.2': doneTask({ depends_on: ['T0.1'] }) },
  };
}

test('adds new tasks with normalized defaults', () => {
  const data = registry();
  const { added, skipped } = mergeSeedTasks(
    data,
    { A1: { title: 'KeyService', phase: 'A', depends_on: ['T0.2'] } },
    NOW,
  );
  assert.deepEqual(added, ['A1']);
  assert.deepEqual(skipped, []);
  assert.deepEqual(data.tasks['A1'], {
    title: 'KeyService',
    phase: 'A',
    depends_on: ['T0.2'],
    mock_start_ok: false,
    note: null,
    status: 'available',
    owner: null,
    branch: null,
    pr: null,
    claimed_at: null,
    updated_at: NOW,
  });
});

test('phase defaults to null when the seed omits it', () => {
  const data = registry();
  mergeSeedTasks(data, { A1: { title: 'KeyService', depends_on: [] } }, NOW);
  assert.equal(data.tasks['A1'].phase, null);
});

test('never overwrites an existing id — reports it as skipped, object untouched', () => {
  const data = registry();
  const before = structuredClone(data.tasks['T0.1']);
  const { added, skipped } = mergeSeedTasks(
    data,
    {
      'T0.1': { title: 'imposter', status: 'available' },
      B1: { title: 'new one', depends_on: [] },
    },
    NOW,
  );
  assert.deepEqual(skipped, ['T0.1']);
  assert.deepEqual(added, ['B1']);
  assert.deepEqual(data.tasks['T0.1'], before);
});

test('a seed cannot smuggle status/owner — entries are born available and unowned', () => {
  const data = registry();
  mergeSeedTasks(
    data,
    { B1: { title: 'sneaky', depends_on: [], status: 'done', owner: 'me' } },
    NOW,
  );
  assert.equal(data.tasks['B1'].status, 'available');
  assert.equal(data.tasks['B1'].owner, null);
});

test('seed-internal dependencies resolve; unknown dependencies reject the batch', () => {
  const ok = registry();
  const res = mergeSeedTasks(
    ok,
    {
      A1: { title: 'a', depends_on: ['T0.2'] },
      A2: { title: 'b', depends_on: ['A1'] },
    },
    NOW,
  );
  assert.deepEqual(res.added, ['A1', 'A2']);

  const bad = registry();
  assert.throws(
    () => mergeSeedTasks(bad, { A1: { title: 'a', depends_on: ['A9'] } }, NOW),
    (err) => err instanceof UsageError && /unknown "A9"/.test(err.message),
  );
});

test('prefix group tokens (T0*, A*) resolve when at least one member exists', () => {
  const data = registry();
  const res = mergeSeedTasks(
    data,
    {
      A1: { title: 'a', depends_on: ['T0*'] },
      B1: { title: 'b', depends_on: ['A*'] },
    },
    NOW,
  );
  assert.deepEqual(res.added, ['A1', 'B1']);
  assert.throws(
    () => mergeSeedTasks(registry(), { A1: { title: 'a', depends_on: ['Z*'] } }, NOW),
    UsageError,
  );
});

test('rejects malformed ids, empty titles, malformed depends_on, empty seeds', () => {
  assert.throws(() => mergeSeedTasks(registry(), { '9bad': { title: 'x' } }, NOW), UsageError);
  assert.throws(() => mergeSeedTasks(registry(), { 'A 1': { title: 'x' } }, NOW), UsageError);
  assert.throws(() => mergeSeedTasks(registry(), { 'A1*': { title: 'x' } }, NOW), UsageError);
  assert.throws(() => mergeSeedTasks(registry(), { A1: { title: '  ' } }, NOW), UsageError);
  assert.throws(
    () => mergeSeedTasks(registry(), { A1: { title: 'x', depends_on: 'T0.1' } }, NOW),
    UsageError,
  );
  assert.throws(() => mergeSeedTasks(registry(), {}, NOW), UsageError);
});

test('mock_start_ok is carried through when the seed sets it', () => {
  const data = registry();
  mergeSeedTasks(data, { E2: { title: 'confess UI', depends_on: [], mock_start_ok: true } }, NOW);
  assert.equal(data.tasks['E2'].mock_start_ok, true);
});

test('dotted and dashed ids are both accepted (T0.1 and WS3-T2 styles)', () => {
  const data = registry();
  const { added } = mergeSeedTasks(
    data,
    {
      'T0.5': { title: 'dotted', depends_on: [] },
      'WS3-T2': { title: 'dashed', depends_on: [] },
    },
    NOW,
  );
  assert.deepEqual(added, ['T0.5', 'WS3-T2']);
});
