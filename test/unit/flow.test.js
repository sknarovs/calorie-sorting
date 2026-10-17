const test = require('node:test');
const assert = require('node:assert/strict');
const { needsConfirm, estimateSeconds, startCooldown, inCooldown } = require('../../barbora-calorie-sort.user.js');
const { fakeStorage } = require('./helpers');

test('a rate-limit cooldown lasts five minutes and is shared through storage', () => {
  const s = fakeStorage();
  assert.equal(inCooldown(s, 0), false);
  startCooldown(s, 1000);
  assert.equal(inCooldown(s, 1000 + 4 * 60_000), true);
  assert.equal(inCooldown(s, 1000 + 6 * 60_000), false);
  s.data.set('bcs:cooldown', '{broken');
  assert.equal(inCooldown(s, 1000), false);
});

test('needsConfirm only above 300', () => {
  assert.equal(needsConfirm(300), false);
  assert.equal(needsConfirm(301), true);
});

test('estimateSeconds is N / 30, rounded, at least 1', () => {
  assert.equal(estimateSeconds(650), 22);
  assert.equal(estimateSeconds(10), 1);
  assert.equal(estimateSeconds(0), 1);
});
