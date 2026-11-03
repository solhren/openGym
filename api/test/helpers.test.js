import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleState, recentSampleState } from './helpers.mjs';

test('recent queue fixtures stay recent at year/leap/future boundaries without changing historical payload fixtures', () => {
  for (const [on, expected] of [['2027-01-01', '2026-12-31'], ['2028-03-01', '2028-02-29'], ['2035-10-27', '2035-10-26']]) {
    const now = Date.parse(on + 'T12:00:00Z');
    const state = recentSampleState({}, now);
    assert.equal(state.workouts[0].d, expected);
    assert.equal(state.bodyweight.at(-1).d, expected);
    assert.ok(state.bodyweight[0].d < expected);
    assert.equal(state.workouts[0].entries[0].sets.length, 3);
  }
  assert.equal(sampleState().workouts[0].d, '2026-07-20');
});

test('explicit missing or old history is not refreshed by the recent fixture', () => {
  const workouts = [{ id: 'old', d: '2000-01-01' }], bodyweight = [];
  assert.deepEqual(recentSampleState({ workouts: [], bodyweight }).workouts, []);
  const state = recentSampleState({ workouts, bodyweight }, Date.parse('2035-10-27T12:00:00Z'));
  assert.equal(state.workouts, workouts);
  assert.equal(state.bodyweight, bodyweight);
});
