import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireBrowser, launchBrowser } from '../src/archive/browser-acquisition.js';
import { CollectorError } from '../src/archive/collector-security.js';
import { summarizeBrowserUsage } from '../src/archive/browser-usage.js';

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

const utc = value => Date.parse(`2026-10-${value}Z`);
const normalSession = (sessionId, startTime, endTime, overrides = {}) => ({
  sessionId, startTime, endTime, closeReason: 1, closeReasonText: 'NormalClosure', ...overrides,
});
const creationLimit = () => new Error('Unable to create new browser: code: 429: message: Rate limit exceeded');

test('usage sums only UTC-today intersections and deduplicates normally closed sessions', () => {
  const start = utc('19T00:00:00');
  const end = utc('19T01:00:00');
  const first = normalSession('one', start - 30_000, start + 20_000);
  const history = [first, first, normalSession('two', start + 10_000, start + 40_000,
    { closeReason: 2, closeReasonText: 'BrowserIdle' }), normalSession('yesterday', start - 60_000, start)];
  assert.deepEqual(summarizeBrowserUsage(history, end), { entries: 4, normalClosedSessionsToday: 2, normalClosedSecondsToday: 50 });
  assert.equal(summarizeBrowserUsage(history, utc('20T01:00:00')).normalClosedSecondsToday, 0);
});

test('usage rejects open, failed, unknown, conflicting and malformed session data', () => {
  const start = utc('19T00:00:00');
  const now = start + 60_000;
  const good = normalSession('good', start, start + 1_250);
  const history = [good, null, {}, normalSession('', start, now),
    normalSession('open', start, undefined), normalSession('future', start, now + 1),
    normalSession('reverse', now, start), normalSession('negative', -1, now),
    normalSession('string', String(start), now), normalSession('nan', NaN, now),
    normalSession('infinity', start, Infinity), normalSession('infrastructure', start, now,
      { closeReason: 5, closeReasonText: 'SessionEvicted' }),
    normalSession('unknown', start, now, { closeReason: 99 }),
    normalSession('text-only', start, now, { closeReason: undefined }),
    normalSession('mismatched', start, now, { closeReasonText: 'BrowserIdle' }),
    normalSession('conflict', start, now), normalSession('conflict', start, now,
      { closeReason: 5, closeReasonText: 'SessionEvicted' })];
  assert.deepEqual(summarizeBrowserUsage(history, now), { entries: history.length, normalClosedSessionsToday: 1, normalClosedSecondsToday: 1.25 });
  assert.equal(summarizeBrowserUsage(null, now).normalClosedSecondsToday, 0);
  assert.equal(summarizeBrowserUsage([good], NaN).normalClosedSecondsToday, 0);
});

test('conflicting duplicate durations use the smaller known duration, independently of ordering', () => {
  const start = utc('19T00:00:00');
  const history = [normalSession('same', start, start + 600_000), normalSession('same', start, start + 500_000)];
  assert.equal(summarizeBrowserUsage(history, start + 700_000).normalClosedSecondsToday, 500);
  assert.equal(summarizeBrowserUsage(history.toReversed(), start + 700_000).normalClosedSecondsToday, 500);
});

test('a configured daily budget reached by known normal usage stops on the first creation 429', async () => {
  const failedAt = utc('19T01:00:00');
  const waits = [];
  let creations = 0;
  let histories = 0;
  const binding = {};
  const lib = {
    acquire: async () => { creations++; throw creationLimit(); },
    history: async actual => { assert.equal(actual, binding); histories++; return [
      normalSession('normal', failedAt - 700_000, failedAt - 400_000),
      normalSession('idle', failedAt - 400_000, failedAt - 100_000, { closeReason: 2, closeReasonText: 'BrowserIdle' })]; },
  };
  await assert.rejects(acquireBrowser(lib, binding, {}, { now: () => failedAt, sleep: async delay => waits.push(delay), dailyBudgetSeconds: 600 }), error => {
    assert.equal(error.code, 'BROWSER_QUOTA_EXCEEDED');
    assert.equal(error.status, 429);
    assert.equal(error.quota, 'browser_budget');
    assert.equal(error.retry_at, utc('20T00:00:00'));
    assert.match(error.message, /本项目今日浏览器运行预算已达到暂停阈值/);
    assert.doesNotMatch(error.message, /计费|免费额度/);
    return true;
  });
  assert.equal(creations, 1);
  assert.equal(histories, 1);
  assert.deepEqual(waits, []);
});

test('599999 milliseconds stays below a 600-second budget and generic creation 429 remains busy', async () => {
  const now = utc('19T01:00:00');
  const waits = [];
  let creations = 0;
  const lib = { launch: async () => { creations++; throw creationLimit(); },
    history: async () => [normalSession('short', now - 600_000, now - 1)] };
  await assert.rejects(launchBrowser(lib, {}, {}, { now: () => now, sleep: async delay => waits.push(delay), dailyBudgetSeconds: 600 }),
    error => error.code === 'BROWSER_BUSY');
  assert.equal(creations, 3);
  assert.deepEqual(waits, [20_000, 10_000]);
});

test('history absence, errors and infrastructure-only usage cannot establish budget exhaustion', async () => {
  const now = utc('19T01:00:00');
  for (const history of [undefined, async () => { throw new Error('history unavailable'); }, async () => null,
    async () => [normalSession('failed', now - 751_000, now, { closeReason: 5, closeReasonText: 'SessionEvicted' })],
    async () => [normalSession('unknown', now - 751_000, now, { closeReason: 99, closeReasonText: 'Unknown' })],
    async () => [normalSession('conflicting', now - 751_000, now, { closeReason: 1, closeReasonText: 'SessionEvicted' })]]) {
    const waits = [];
    let calls = 0;
    await assert.rejects(acquireBrowser({ acquire: async () => { calls++; throw creationLimit(); }, ...(history ? { history } : {}) }, {}, {},
      { now: () => now, sleep: async delay => waits.push(delay), dailyBudgetSeconds: 600 }), error => error.code === 'BROWSER_BUSY');
    assert.equal(calls, 3);
    assert.deepEqual(waits, [20_000, 10_000]);
  }
});

test('history is read only for a configured budget after a creation 429', async () => {
  const timer = clock();
  let histories = 0;
  const history = async () => { histories++; throw new Error('must not be called'); };
  assert.equal(await acquireBrowser({ acquire: async () => 'session', history }, {}, {}, { ...timer, dailyBudgetSeconds: 600 }), 'session');
  for (const dailyBudgetSeconds of [undefined, 0, -1, NaN, '600']) {
    await assert.rejects(acquireBrowser({ acquire: async () => { throw creationLimit(); }, history }, {}, {},
      { ...timer, dailyBudgetSeconds }), error => error.code === 'BROWSER_BUSY');
  }
  for (const error of [new Error('network failure'), new Error('Unable to connect to browser: code: 429'),
    Object.assign(new CollectorError('BROWSER_BUSY', 'busy'), { status: 503 }),
    new Error('Unable to create new browser: code: 429: Browser time limit exceeded for today')]) {
    await assert.rejects(acquireBrowser({ acquire: async () => { throw error; }, history }, {}, {},
      { ...timer, dailyBudgetSeconds: 600 }));
  }
  assert.equal(histories, 0);
});

test('the failure time selects the budget day after an acquisition crosses UTC midnight', async () => {
  let now = utc('19T23:59:59');
  const nextDay = utc('20T00:00:00');
  const waits = [];
  let calls = 0;
  const lib = { acquire: async () => {
    if (++calls === 1) { now = nextDay; throw creationLimit(); }
    return 'next-day-browser';
  }, history: async () => [normalSession('yesterday', nextDay - 700_000, nextDay - 1)] };
  assert.equal(await acquireBrowser(lib, {}, {}, { now: () => now, sleep: async delay => { waits.push(delay); now += delay; }, dailyBudgetSeconds: 600 }), 'next-day-browser');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [20_000]);
});

test('a history response arriving after UTC midnight cannot pause the new day using old usage', async () => {
  const nextDay = utc('20T00:00:00');
  let now = nextDay - 1000;
  let creations = 0;
  const waits = [];
  const lib = {
    acquire: async () => { if (++creations === 1) throw creationLimit(); return 'new-day-browser'; },
    history: async () => {
      now = nextDay + 1000;
      return [normalSession('old-day', nextDay - 700_000, nextDay - 1)];
    },
  };
  assert.equal(await acquireBrowser(lib, {}, {}, { now: () => now, dailyBudgetSeconds: 600,
    sleep: async delay => { waits.push(delay); now += delay; } }), 'new-day-browser');
  assert.equal(creations, 2);
  assert.deepEqual(waits, [20_000]);
});

test('a daily budget error resumes normally on the next UTC day', async () => {
  let now = utc('19T23:59:59');
  let blocked = true;
  const history = [normalSession('today', now - 700_000, now - 1)];
  const lib = { acquire: async () => { if (blocked) throw creationLimit(); return 'restored'; }, history: async () => history };
  const dependencies = { now: () => now, sleep: async () => assert.fail('no sleep expected'), dailyBudgetSeconds: 600 };
  let retryAt;
  await assert.rejects(acquireBrowser(lib, {}, {}, dependencies), error => { retryAt = error.retry_at; return error.code === 'BROWSER_QUOTA_EXCEEDED'; });
  now = retryAt;
  blocked = false;
  assert.equal(await acquireBrowser(lib, {}, {}, dependencies), 'restored');
  assert.equal(summarizeBrowserUsage(history, now).normalClosedSecondsToday, 0);
});
