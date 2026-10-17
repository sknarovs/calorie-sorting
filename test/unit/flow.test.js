const test = require('node:test');
const assert = require('node:assert/strict');
const { needsConfirm, estimateSeconds } = require('../../barbora-calorie-sort.user.js');

test('needsConfirm only above 300', () => {
  assert.equal(needsConfirm(300), false);
  assert.equal(needsConfirm(301), true);
});

test('estimateSeconds is N / 30, rounded, at least 1', () => {
  assert.equal(estimateSeconds(650), 22);
  assert.equal(estimateSeconds(10), 1);
  assert.equal(estimateSeconds(0), 1);
});
