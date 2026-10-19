import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WechatThrottle } from '../src/archive/wechat-throttle.js';
import { CollectorError } from '../src/archive/collector-security.js';

function database(t, migrate = true) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  if (migrate) sqlite.exec(readFileSync(new URL('../migrations/0004_wechat_throttle.sql', import.meta.url), 'utf8'));
  return { sqlite, prepare(sql) {
    const statement = values => ({ bind: (...bound) => statement(bound), first: async () => sqlite.prepare(sql).get(...values) || null });
    return statement([]);
  } };
}

test('first reservation is immediate and a second instance sees the same ten-second interval', async t => {
  const db = database(t);
  let now = 100_000;
  assert.deepEqual(await new WechatThrottle(db, () => now).reserve(), { next_allowed_at: 110_000 });
  await assert.rejects(new WechatThrottle(db, () => now).reserve(), error => {
    assert.ok(error instanceof CollectorError);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.status, 429);
    assert.equal(error.retryable, true);
    assert.equal(error.retry_at, 110_000);
    assert.equal(error.transport, 'http');
    return true;
  });
  now = 109_999;
  await assert.rejects(new WechatThrottle(db, () => now).reserve(), error => error.retry_at === 110_000);
  now = 110_000;
  assert.equal((await new WechatThrottle(db, () => now).reserve()).next_allowed_at, 120_000);
});

test('atomic reservations allow only one winner across simultaneous executor instances', async t => {
  const db = database(t);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => new WechatThrottle(db, () => 200_000).reserve()));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const blocked = results.filter(result => result.status === 'rejected');
  assert.equal(blocked.length, 11);
  assert.ok(blocked.every(result => result.reason.code === 'RATE_LIMITED' && result.reason.retry_at === 210_000));
});

test('an upstream rate limit extends the account wait to sixty seconds from its response time', async t => {
  const db = database(t);
  let now = 300_000;
  const throttle = new WechatThrottle(db, () => now);
  await throttle.reserve();
  now += 5_000;
  assert.equal((await throttle.cooldown()).next_allowed_at, 365_000);
  now = 364_999;
  await assert.rejects(new WechatThrottle(db, () => now).reserve(), error => error.retry_at === 365_000);
  now = 365_000;
  assert.equal((await new WechatThrottle(db, () => now).reserve()).next_allowed_at, 375_000);
});

test('older or concurrent cooldown updates can never shorten an existing wait', async t => {
  const db = database(t);
  await new WechatThrottle(db, () => 500_000).cooldown();
  await new WechatThrottle(db, () => 400_000).cooldown();
  const results = await Promise.all([new WechatThrottle(db, () => 510_000).cooldown(), new WechatThrottle(db, () => 505_000).cooldown()]);
  assert.ok(results.every(row => row.next_allowed_at === 570_000));
  const row = db.sqlite.prepare('SELECT * FROM archive_wechat_throttle WHERE singleton=1').get();
  assert.equal(row.next_allowed_at, 570_000);
  assert.equal(row.updated_at, 510_000);
});

test('a failed caller keeps its ten-second reservation instead of releasing capacity early', async t => {
  const db = database(t);
  await new WechatThrottle(db, () => 600_000).reserve();
  await assert.rejects(new WechatThrottle(db, () => 609_999).reserve(), error => error.retry_at === 610_000);
  assert.equal((await new WechatThrottle(db, () => 610_000).reserve()).next_allowed_at, 620_000);
});

test('a missing table, singleton or binding never silently disables production throttling', async t => {
  const db = database(t, false);
  for (const method of ['reserve', 'cooldown']) {
    await assert.rejects(new WechatThrottle(db, () => 1)[method](), error => error.code === 'CONFIG_MISSING');
  }
  db.sqlite.exec(readFileSync(new URL('../migrations/0004_wechat_throttle.sql', import.meta.url), 'utf8'));
  db.sqlite.exec('DELETE FROM archive_wechat_throttle');
  for (const method of ['reserve', 'cooldown']) {
    await assert.rejects(new WechatThrottle(db, () => 1)[method](), error => error.code === 'CONFIG_MISSING');
    await assert.rejects(new WechatThrottle(undefined, () => 1)[method](), error => error.code === 'CONFIG_MISSING');
  }
});

test('invalid clocks do not write a wait and database failures are propagated', async t => {
  const db = database(t);
  for (const now of [-1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(new WechatThrottle(db, () => now).reserve(), error => error.code === 'CONFIG_INVALID');
  }
  assert.equal(db.sqlite.prepare('SELECT next_allowed_at FROM archive_wechat_throttle').get().next_allowed_at, 0);
  const failure = new Error('temporary database unavailable');
  await assert.rejects(new WechatThrottle({ prepare: () => { throw failure; } }, () => 1).reserve(), error => error === failure);
});

test('reapplying the migration cannot reset an account cooldown', async t => {
  const db = database(t);
  await new WechatThrottle(db, () => 700_000).cooldown();
  db.sqlite.exec(readFileSync(new URL('../migrations/0004_wechat_throttle.sql', import.meta.url), 'utf8'));
  await assert.rejects(new WechatThrottle(db, () => 700_001).reserve(), error => error.retry_at === 760_000);
});
