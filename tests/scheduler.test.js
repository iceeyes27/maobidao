import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automaticWindow } from '../src/archive/core.js';
import { ensureScheduler, runScheduler, schedulerDay, schedulerId } from '../src/archive/scheduler.js';

const DAY = 86_400_000;
const INTERVAL = 300_000;
const day = Date.UTC(2026, 9, 19);

function database(fail = () => false) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return { bind(...values) {
        return { async run() {
          writes.push({ sql, values });
          if (fail(sql, values)) throw new Error('Temporary D1 failure');
          return { meta: { changes: 1 } };
        } };
      } };
    },
  };
}

function timer(initial = day) {
  let current = initial;
  const steps = [];
  return {
    now: () => current,
    steps,
    step: {
      async sleepUntil(name, timestamp) {
        if (Number(timestamp) < current) throw new Error("You can't sleep until a time in the past, time-traveler");
        current = Number(timestamp);
        steps.push({ type: 'sleep', name, timestamp });
      },
      async do(name, config, action) {
        steps.push({ type: 'do', name });
        // A rejection represents an operation whose configured retries failed.
        return (typeof config === 'function' ? config : action)();
      },
    },
  };
}

function newScheduler(onCreate = () => {}) {
  const created = [];
  return {
    created,
    async get() { throw new Error('Workflow instance does not exist'); },
    async create(options) { created.push(options); return onCreate(options); },
  };
}

test('scheduler uses a stable UTC day ID and rejects an arbitrary timestamp', () => {
  assert.equal(schedulerDay(day + DAY - 1), day);
  assert.equal(schedulerId(day), 'archive-schedule-2026-10-19');
  assert.throws(() => schedulerId(day + 1), /Invalid scheduler day/);
});

test('a daily scheduler persists tomorrow before the first tick and stays within the free step limit', async () => {
  const clock = timer();
  const events = [];
  const binding = newScheduler(options => events.push({ type: 'create', options }));
  const env = { ARCHIVE_SCHEDULER: binding, ARCHIVE_DB: database() };
  const result = await runScheduler(env, clock.step, day, async controller => {
    events.push({ type: 'tick', timestamp: controller.scheduledTime });
  }, clock.now);
  assert.deepEqual(result, { day, state: 'completed' });
  assert.deepEqual(events[0], {
    type: 'create', options: { id: schedulerId(day + DAY), params: { day: day + DAY } },
  });
  assert.equal(binding.created.length, 1);
  assert.equal(events.filter(event => event.type === 'tick').length, 288);
  assert.ok(clock.steps.filter(step => step.type === 'do').length < 1024);
});

test('late startup skips old ticks while preserving the scheduled 23:30 final check', async () => {
  // Beijing 21:37:00. A check less than five minutes late may still run once.
  const clock = timer(day + 13 * 3_600_000 + 37 * 60_000);
  const executed = [];
  const automatic = [];
  const env = { ARCHIVE_SCHEDULER: newScheduler(), ARCHIVE_DB: database() };
  await runScheduler(env, clock.step, day, async controller => {
    executed.push(controller.scheduledTime);
    const window = automaticWindow(controller.scheduledTime);
    if (window.active) automatic.push({ ...window, tick: controller.scheduledTime });
  }, clock.now);
  assert.equal(executed[0], day + 13 * 3_600_000 + 35 * 60_000);
  assert.ok(executed.every(tick => tick >= executed[0]));
  assert.equal(automatic.at(-1).tick, day + 15 * 3_600_000 + 30 * 60_000);
  assert.equal(automatic.at(-1).final, true);
  assert.equal(automatic.filter(tick => tick.final).length, 1);
});

test('a future daily instance sleeps until its day starts without requesting past sleeps', async () => {
  const clock = timer(day - 60_000);
  const env = { ARCHIVE_SCHEDULER: newScheduler(), ARCHIVE_DB: database() };
  await runScheduler(env, clock.step, day, async () => {}, clock.now);
  assert.deepEqual(clock.steps[0], { type: 'sleep', name: 'day-start', timestamp: day });
});

test('an expired daily instance skips all old work without sleeping or spending workflow steps', async () => {
  const clock = timer(day + DAY);
  const env = { ARCHIVE_SCHEDULER: newScheduler(), ARCHIVE_DB: database() };
  await runScheduler(env, clock.step, day, async () => assert.fail('An expired tick was replayed'), clock.now);
  assert.deepEqual(clock.steps, []);
  assert.deepEqual(env.ARCHIVE_SCHEDULER.created, []);
});

test('an ambiguous creation response checks and reuses the same scheduler ID', async () => {
  let exists = false;
  const created = [];
  const readIds = [];
  const env = { ARCHIVE_SCHEDULER: {
    async get(id) {
      readIds.push(id);
      if (!exists) throw new Error('Workflow instance not found');
      return { status: async () => ({ status: 'running' }) };
    },
    async create(options) {
      created.push(options);
      exists = true;
      throw new Error('Response lost after create was accepted');
    },
  } };
  assert.deepEqual(await ensureScheduler(env, day), { id: schedulerId(day), status: 'running' });
  assert.deepEqual(created, [{ id: schedulerId(day), params: { day } }]);
  assert.ok(readIds.every(id => id === schedulerId(day)));
});

test('paused and failed scheduler instances recover without creating a second ID', async () => {
  for (const status of ['paused', 'errored', 'terminated', 'complete']) {
    const calls = [];
    const instance = {
      status: async () => ({ status }),
      resume: async () => calls.push('resume'),
      restart: async () => calls.push('restart'),
    };
    const env = { ARCHIVE_SCHEDULER: {
      get: async id => { assert.equal(id, schedulerId(day)); return instance; },
      create: async () => assert.fail('An existing scheduler must retain its ID'),
    } };
    const result = await ensureScheduler(env, day);
    assert.deepEqual(calls, [status === 'paused' ? 'resume' : 'restart']);
    assert.equal(result.status, status === 'paused' ? 'running' : 'queued');
  }
});

test('an unknown scheduler status is left unchanged for a later retry', async () => {
  const env = { ARCHIVE_SCHEDULER: { get: async () => ({
    status: async () => ({ status: 'unknown' }),
    restart: async () => assert.fail('An unknown instance must not be restarted'),
  }) } };
  await assert.rejects(ensureScheduler(env, day), /unavailable/);
});

test('failure to create tomorrow retries on a later tick without blocking today', async t => {
  t.mock.method(console, 'warn', () => {});
  const clock = timer();
  let creates = 0;
  let ticks = 0;
  const env = {
    ARCHIVE_DB: database(),
    ARCHIVE_SCHEDULER: newScheduler(() => { if (++creates < 3) throw new Error('Temporary create failure'); }),
  };
  await runScheduler(env, clock.step, day, async () => { ticks++; }, clock.now);
  assert.equal(creates, 3);
  assert.equal(ticks, 288);
  assert.equal(clock.steps.filter(step => step.name.startsWith('ensure-next-day-')).length, 3);
});

test('a failed tick records its failure and the next check still runs', async t => {
  t.mock.method(console, 'warn', () => {});
  const clock = timer();
  const executed = [];
  const env = { ARCHIVE_SCHEDULER: newScheduler(), ARCHIVE_DB: database() };
  await runScheduler(env, clock.step, day, async controller => {
    executed.push(controller.scheduledTime);
    if (controller.scheduledTime === day) throw new Error('Temporary source failure');
  }, clock.now);
  assert.equal(executed.length, 288);
  assert.equal(executed[1], day + INTERVAL);
  assert.ok(env.ARCHIVE_DB.writes.some(write => write.values.includes('定时检查暂时失败，下一次检查将继续。')));
});

test('failure to persist a tick error cannot stop the remaining daily checks', async t => {
  t.mock.method(console, 'warn', () => {});
  const clock = timer();
  let ticks = 0;
  const env = {
    ARCHIVE_SCHEDULER: newScheduler(),
    ARCHIVE_DB: database((_sql, values) => values[1] === day),
  };
  await runScheduler(env, clock.step, day, async () => { ticks++; }, clock.now);
  assert.equal(ticks, 288);
  assert.ok(env.ARCHIVE_DB.writes.some(write => write.values[1] === day + INTERVAL));
});

test('the final tick relays only existing dispatch work without adding any source checks', async () => {
  const clock = timer();
  const env = { ARCHIVE_SCHEDULER: newScheduler(), ARCHIVE_DB: database() };
  const finalTick = day + 15 * 3_600_000 + 30 * 60_000;
  const scheduled = [];
  const relays = [];
  let pending = false;
  let accepted = 0;
  await runScheduler(env, clock.step, day, async controller => {
    scheduled.push(controller.scheduledTime);
    if (controller.scheduledTime === finalTick) pending = true;
  }, clock.now, async () => {
    relays.push(clock.now());
    // The previous workflow has completed by the first relay; later relays are idempotent.
    if (pending) { pending = false; accepted++; }
  });
  assert.equal(scheduled.length, 288);
  assert.equal(scheduled.filter(tick => automaticWindow(tick).active).length, 25);
  assert.equal(scheduled.filter(tick => tick === finalTick).length, 1);
  assert.deepEqual(relays, [15_000, 60_000, 180_000, 240_000].map(delay => finalTick + delay));
  assert.equal(accepted, 1);
  assert.ok(relays.every(time => time > finalTick && time < finalTick + INTERVAL));
  assert.ok(clock.steps.filter(step => step.type === 'do').length < 1024);
});
