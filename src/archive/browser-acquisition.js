import { CollectorError, collectorDiagnostic } from './collector-security.js';
import { summarizeBrowserUsage } from './browser-usage.js';

const MAX_WAIT_MS = 30_000;
const ACQUISITION_INTERVAL_MS = 20_000;
const MAX_ROUNDS = 3;
const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function busy(now, diagnostic, status = 429) {
  const error = new CollectorError('BROWSER_BUSY', '云端浏览器暂时繁忙，请稍后重试', true);
  error.status = status;
  error.quota = 'browser_capacity';
  error.retry_at = now() + ACQUISITION_INTERVAL_MS;
  error.diagnostic = `browser_capacity: ${diagnostic}`;
  return error;
}

function dailyQuota(error) {
  return error?.code === 'BROWSER_QUOTA_EXCEEDED'
    || /browser\s+time\s+limit\s+exceeded/i.test(`${error?.message || ''} ${error?.cause?.message || ''}`);
}

function creationBusy(error) {
  const message = `${error?.message || ''} ${error?.cause?.message || ''}`;
  // launch() also connects after acquisition. Repeating a failed connection could
  // create another browser while the already acquired browser remains alive.
  if (/unable to connect to browser/i.test(message)) return false;
  return error?.code === 'BROWSER_BUSY' || creation429(error);
}

function creation429(error) {
  return Number(error?.status) === 429 || Number(error?.cause?.status) === 429
    || /\b(?:code|status|http)(?:\s+code)?\s*:?\s*429\b/i.test(`${error?.message || ''} ${error?.cause?.message || ''}`);
}

async function budgetExhausted(lib, binding, budgetSeconds, failedAt, now) {
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0 || typeof lib.history !== 'function') return null;
  let usage;
  try {
    const history = await lib.history(binding);
    const checkedAt = now();
    // A slow history response cannot carry yesterday's pause into a new UTC day.
    if (Math.floor(checkedAt / 86_400_000) !== Math.floor(failedAt / 86_400_000)) return null;
    usage = summarizeBrowserUsage(history, checkedAt);
  }
  catch { return null; }
  if (usage.normalClosedSecondsToday < budgetSeconds) return null;
  const error = new CollectorError('BROWSER_QUOTA_EXCEEDED', '本项目今日浏览器运行预算已达到暂停阈值，请在预算重置后重试');
  error.status = 429;
  error.quota = 'browser_budget';
  error.retry_at = (Math.floor(failedAt / 86_400_000) + 1) * 86_400_000;
  error.diagnostic = 'browser_budget: configured_daily_budget_reached';
  return error;
}

function readCapacity(value, now) {
  if (!value || !Array.isArray(value.activeSessions)
    || !Number.isInteger(value.maxConcurrentSessions) || value.maxConcurrentSessions < 1
    || !Number.isInteger(value.allowedBrowserAcquisitions) || value.allowedBrowserAcquisitions < 0
    || !Number.isFinite(value.timeUntilNextAllowedBrowserAcquisition)
    || value.timeUntilNextAllowedBrowserAcquisition < 0) {
    throw busy(now, 'limits_invalid', 503);
  }
  if (value.activeSessions.length >= value.maxConcurrentSessions) return 'concurrent_limit';
  return value.allowedBrowserAcquisitions > 0 ? null : 'acquisition_limit';
}

async function createBrowser(lib, binding, method, options, { now = Date.now, sleep = defaultSleep, dailyBudgetSeconds } = {}) {
  const startedAt = now();
  let waited = 0;
  let reason = 'acquisition_limit';
  let providerDiagnostic;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // The documented field has no declared time unit. Use it only for response
    // validation; the Free plan documents one new browser every 20 seconds.
    reason = typeof lib.limits === 'function' ? readCapacity(await lib.limits(binding), now) : null;
    if (!reason) {
      try {
        return await lib[method](binding, options);
      } catch (error) {
        if (dailyQuota(error) || !creationBusy(error)) throw error;
        // Evaluate the UTC day at this failure, not at the start of a request
        // that may already have waited across midnight.
        const failedAt = now();
        if (creation429(error)) {
          const exhausted = await budgetExhausted(lib, binding, dailyBudgetSeconds, failedAt, now);
          if (exhausted) throw exhausted;
        }
        reason = 'creation_429';
        providerDiagnostic = collectorDiagnostic(error);
      }
    }
    const remaining = MAX_WAIT_MS - Math.max(waited, now() - startedAt);
    if (round === MAX_ROUNDS - 1 || remaining <= 0) break;
    const delay = Math.min(ACQUISITION_INTERVAL_MS, remaining);
    await sleep(delay);
    // Count requested sleep as well as wall time so an interrupted sleep or an
    // injected clock cannot turn a bounded acquisition into an unbounded loop.
    waited += delay;
  }
  const error = busy(now, reason);
  if (providerDiagnostic) error.diagnostic += `; ${providerDiagnostic}`;
  throw error;
}

export function launchBrowser(lib, binding, options = {}, dependencies) {
  return createBrowser(lib, binding, 'launch', options, dependencies);
}

export function acquireBrowser(lib, binding, options = {}, dependencies) {
  return createBrowser(lib, binding, 'acquire', options, dependencies);
}
