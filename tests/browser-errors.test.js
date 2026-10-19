import assert from 'node:assert/strict';
import test from 'node:test';
import { CollectorError, classifyCollectorError } from '../src/archive/collector-security.js';

const now = Date.parse('2026-10-20T23:59:50Z');

function assertCapacity(error) {
  assert.equal(error.code, 'BROWSER_BUSY');
  assert.equal(error.retryable, true);
  assert.equal(error.status, 429);
  assert.equal(error.quota, 'browser_capacity');
  assert.equal(error.retry_at, now + 20000);
  assert.ok(!error.message.includes('今日'));
}

test('daily browser time takes precedence over a new-browser HTTP 429 and resumes at UTC midnight', () => {
  const error = classifyCollectorError(new Error('Unable to create new browser: code: 429: message: Browser time limit exceeded for today'), now);
  assert.equal(error.code, 'BROWSER_QUOTA_EXCEEDED');
  assert.equal(error.retryable, false);
  assert.equal(error.quota, 'browser_time');
  assert.equal(error.retry_at, Date.parse('2026-10-21T00:00:00Z'));
});

test('daily time exhaustion at UTC midnight waits until the following UTC day', () => {
  const midnight = Date.parse('2026-10-21T00:00:00Z');
  const error = classifyCollectorError(new Error('SDK request failed', {
    cause: new Error('Browser time limit exceeded for today'),
  }), midnight);
  assert.equal(error.code, 'BROWSER_QUOTA_EXCEEDED');
  assert.equal(error.retry_at, Date.parse('2026-10-22T00:00:00Z'));
});

test('known SDK creation 429 variants wait briefly without becoming daily quota failures', () => {
  for (const operation of ['create new', 'create a new', 'acquire a', 'launch']) {
    const error = classifyCollectorError(new Error(`Unable to ${operation} browser: code: 429: message: Too many requests`), now);
    assertCapacity(error);
    assert.equal(error.diagnostic, 'browser_capacity: acquisition_limit');
  }
  assertCapacity(classifyCollectorError(Object.assign(new Error('Unable to create new browser'), { status: 429 }), now));
  assertCapacity(classifyCollectorError(new Error('Unable to acquire browser', {
    cause: Object.assign(new Error('Request rejected'), { status: 429 }),
  }), now));
});

test('concurrent browsers and explicit acquisition pacing are temporary browser capacity conditions', () => {
  for (const message of [
    'Unable to connect to browser: code: 429: message: Too many concurrent browsers',
    'Maximum concurrent sessions reached',
    'Concurrent browser limit reached',
    'New browser instances rate limit reached',
    'Browser acquisition is too frequent',
  ]) assertCapacity(classifyCollectorError(new Error(message), now));
});

test('unknown SDK 429 remains neutral and never claims a specific recovery deadline', () => {
  for (const input of [
    Object.assign(new Error('Unexpected browser response'), { status: 429 }),
    new Error('Unexpected browser response: HTTP 429'),
    new Error('Too many concurrent requests'),
  ]) {
    const error = classifyCollectorError(input, now);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.status, 429);
    assert.equal(error.retryable, true);
    assert.equal(error.retry_at, undefined);
    assert.equal(error.quota, undefined);
    assert.ok(!/频率|今日|次日|明天/.test(error.message));
  }
});

test('WeChat source throttling preserves its own classification and message', () => {
  const source = new CollectorError('RATE_LIMITED', '微信暂时限制访问频率', true);
  source.status = 429;
  assert.equal(classifyCollectorError(source, now), source);
  assert.equal(source.retry_at, undefined);
  assert.equal(source.quota, undefined);
});

test('a previously classified browser capacity error retains its exact retry time and private diagnostic', () => {
  const busy = new CollectorError('BROWSER_BUSY', '云端浏览器正在处理其他任务，请稍后重试', true);
  Object.assign(busy, { status: 429, quota: 'browser_capacity', retry_at: now + 12000, diagnostic: 'browser_capacity: acquisition_wait' });
  assert.equal(classifyCollectorError(busy, now), busy);
  assert.equal(busy.retry_at, now + 12000);
  assert.equal(busy.diagnostic, 'browser_capacity: acquisition_wait');
});

test('private capacity diagnostics contain only a fixed classification', () => {
  const error = classifyCollectorError(new Error('Unable to create new browser: code: 429: https://private.example/?token=private-token SessionId: private-session'), now);
  assertCapacity(error);
  assert.equal(error.diagnostic, 'browser_capacity: acquisition_limit');
  assert.ok(!/private|https|token|session/i.test(error.diagnostic));
  assert.ok(!/private|https|token/i.test(error.message));
});

test('non-capacity failures still use the ordinary retryable upstream classification', () => {
  const error = classifyCollectorError(new Error('Connection reset'), now);
  assert.equal(error.code, 'UPSTREAM_ERROR');
  assert.equal(error.retryable, true);
  assert.equal(error.retry_at, undefined);
});
