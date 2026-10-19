import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireBrowser, launchBrowser } from '../src/archive/browser-acquisition.js';
import { CollectorError } from '../src/archive/collector-security.js';

const capacity = (overrides = {}) => ({
  activeSessions: [], maxConcurrentSessions: 3,
  allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0,
  ...overrides,
});
function clock() {
  let time = 1_800_000_000_000;
  const waits = [];
  return { now: () => time, sleep: async (delay) => { waits.push(delay); time += delay; }, waits };
}

for (const [method, operation] of [['launch', launchBrowser], ['acquire', acquireBrowser]]) {
  test(`${method} passes binding and options unchanged when capacity is ready`, async () => {
    const binding = {};
    const options = { keep_alive: 60_000 };
    const result = {};
    const timer = clock();
    const calls = [];
    const lib = {
      limits: async (actual) => { assert.equal(actual, binding); return capacity(); },
      [method]: async (...args) => { calls.push(args); return result; },
    };
    assert.equal(await operation(lib, binding, options, timer), result);
    assert.deepEqual(calls, [[binding, options]]);
    assert.deepEqual(timer.waits, []);
  });
}

test('a denied acquisition waits then checks current limits before creating', async () => {
  const timer = clock();
  let checks = 0;
  let creations = 0;
  const lib = {
    limits: async () => ++checks === 1
      ? capacity({ allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 7 }) : capacity(),
    acquire: async () => { creations++; return { sessionId: 'example' }; },
  };
  assert.deepEqual(await acquireBrowser(lib, {}, {}, timer), { sessionId: 'example' });
  assert.deepEqual(timer.waits, [20_000]);
  assert.equal(checks, 2);
  assert.equal(creations, 1);
});

test('capacity exhaustion is bounded to 30 seconds and three checks without using an unknown time unit', async () => {
  const timer = clock();
  let checks = 0;
  let creations = 0;
  const lib = {
    limits: async () => { checks++; return capacity({ allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 9_999_999 }); },
    launch: async () => { creations++; },
  };
  await assert.rejects(launchBrowser(lib, {}, {}, timer), (error) => {
    assert.ok(error instanceof CollectorError);
    assert.equal(error.code, 'BROWSER_BUSY');
    assert.equal(error.retryable, true);
    assert.equal(error.status, 429);
    assert.equal(error.retry_at, timer.now() + 20_000);
    assert.equal(error.quota, 'browser_capacity');
    assert.equal(error.diagnostic, 'browser_capacity: acquisition_limit');
    return true;
  });
  assert.deepEqual(timer.waits, [20_000, 10_000]);
  assert.equal(checks, 3);
  assert.equal(creations, 0);
});

test('concurrent capacity is respected even if a creation token is available', async () => {
  const timer = clock();
  let creations = 0;
  const lib = {
    limits: async () => capacity({ activeSessions: [{ id: 'private-a' }, { id: 'private-b' }, { id: 'private-c' }] }),
    acquire: async () => { creations++; },
  };
  await assert.rejects(acquireBrowser(lib, {}, {}, timer), (error) => {
    assert.equal(error.diagnostic, 'browser_capacity: concurrent_limit');
    assert.ok(!JSON.stringify(error).includes('private-'));
    return error.code === 'BROWSER_BUSY';
  });
  assert.equal(creations, 0);
  assert.deepEqual(timer.waits, [20_000, 10_000]);
});

test('creation 429 racing a ready check waits and retries with fresh limits', async () => {
  const timer = clock();
  let checks = 0;
  let creations = 0;
  const lib = {
    limits: async () => { checks++; return capacity(); },
    launch: async () => {
      if (++creations === 1) throw new Error('Unable to create new browser: code: 429: message: throttled');
      return 'browser';
    },
  };
  assert.equal(await launchBrowser(lib, {}, {}, timer), 'browser');
  assert.equal(checks, 2);
  assert.equal(creations, 2);
  assert.deepEqual(timer.waits, [20_000]);
});

test('repeated creation 429 stays finite even with an injected frozen clock', async () => {
  const waits = [];
  let creations = 0;
  const lib = { acquire: async () => { creations++; throw Object.assign(new Error('temporary'), { status: 429 }); } };
  await assert.rejects(acquireBrowser(lib, {}, {}, { now: () => 123, sleep: async (delay) => waits.push(delay) }),
    (error) => error.code === 'BROWSER_BUSY' && error.retry_at === 20_123);
  assert.equal(creations, 3);
  assert.deepEqual(waits, [20_000, 10_000]);
});

test('daily browser time quota never waits or retries', async () => {
  for (const failure of [
    new Error('Unable to create new browser: code: 429: message: Browser time limit exceeded for today'),
    Object.assign(new CollectorError('BROWSER_QUOTA_EXCEEDED', 'quota'), { status: 429 }),
  ]) {
    const timer = clock();
    let calls = 0;
    const lib = { acquire: async () => { calls++; throw failure; } };
    await assert.rejects(acquireBrowser(lib, {}, {}, timer), (error) => error === failure);
    assert.equal(calls, 1);
    assert.deepEqual(timer.waits, []);
  }
});

test('the final provider failure remains diagnosable without exposing navigation or credentials', async () => {
  const timer = clock();
  const lib = { acquire: async () => {
    throw new Error('Unable to create new browser: code: 429: message: Provider capacity blocked https://private.example/?token=sensitive-token session_id=private-session');
  } };
  await assert.rejects(acquireBrowser(lib, {}, {}, timer), error => {
    assert.equal(error.code, 'BROWSER_BUSY');
    assert.match(error.diagnostic, /Provider capacity blocked/);
    assert.doesNotMatch(error.diagnostic, /private\.example|sensitive-token|private-session/);
    return true;
  });
});

test('limits errors are returned immediately without trying to create', async () => {
  const timer = clock();
  let creations = 0;
  const failure = Object.assign(new Error('limits request failed'), { status: 429 });
  await assert.rejects(launchBrowser({
    limits: async () => { throw failure; },
    launch: async () => { creations++; },
  }, {}, {}, timer), (error) => error === failure);
  assert.equal(creations, 0);
  assert.deepEqual(timer.waits, []);
});

test('malformed limits fail closed without waiting or creating', async () => {
  for (const limits of [null, {}, capacity({ activeSessions: null }), capacity({ maxConcurrentSessions: 0 }),
    capacity({ allowedBrowserAcquisitions: -1 }), capacity({ timeUntilNextAllowedBrowserAcquisition: NaN }),
    capacity({ timeUntilNextAllowedBrowserAcquisition: '20' })]) {
    const timer = clock();
    let creations = 0;
    await assert.rejects(launchBrowser({ limits: async () => limits, launch: async () => { creations++; } }, {}, {}, timer),
      (error) => error.code === 'BROWSER_BUSY' && error.diagnostic === 'browser_capacity: limits_invalid');
    assert.equal(creations, 0);
    assert.deepEqual(timer.waits, []);
  }
});

test('ordinary creation errors and post-acquisition connection 429 never allocate another browser', async () => {
  for (const failure of [new Error('network disconnected'),
    new Error('Unable to connect to browser: code: 429: message: connection throttled')]) {
    const timer = clock();
    let calls = 0;
    await assert.rejects(launchBrowser({ launch: async () => { calls++; throw failure; } }, {}, {}, timer), (error) => error === failure);
    assert.equal(calls, 1);
    assert.deepEqual(timer.waits, []);
  }
});

test('missing limits on an injected fake permits a direct creation', async () => {
  const timer = clock();
  assert.equal(await acquireBrowser({ acquire: async () => 'session' }, {}, {}, timer), 'session');
  assert.deepEqual(timer.waits, []);
});

test('elapsed platform time consumes the wait budget', async () => {
  let time = 0;
  const waits = [];
  let calls = 0;
  await assert.rejects(acquireBrowser({ limits: async () => {
    calls++;
    time += 35_000;
    return capacity({ allowedBrowserAcquisitions: 0 });
  } }, {}, {}, { now: () => time, sleep: async (delay) => waits.push(delay) }), (error) => error.code === 'BROWSER_BUSY');
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});
