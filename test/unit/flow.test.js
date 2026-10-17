const test = require('node:test');
const assert = require('node:assert/strict');
const { startCooldown, inCooldown } = require('../../barbora-calorie-sort.user.js');
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

