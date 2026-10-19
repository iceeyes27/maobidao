const UTC_DAY_MS = 86_400_000;
const NORMAL_CLOSE_REASONS = new Map([[1, 'NormalClosure'], [2, 'BrowserIdle']]);

/**
 * A conservative lower bound from recent, normally closed sessions, not billing
 * usage. SDK timestamps are milliseconds; open and infrastructure-failed sessions
 * are deliberately excluded. See https://developers.cloudflare.com/browser-run/playwright/#list-recent-sessions
 */
export function summarizeBrowserUsage(history, timestamp) {
  const summary = { entries: Array.isArray(history) ? history.length : 0,
    normalClosedSessionsToday: 0, normalClosedSecondsToday: 0 };
  if (!Array.isArray(history) || !Number.isSafeInteger(timestamp) || timestamp <= 0) return summary;
  const dayStart = Math.floor(timestamp / UTC_DAY_MS) * UTC_DAY_MS;
  const sessions = new Map();
  for (const session of history) {
    if (!session || typeof session.sessionId !== 'string' || !session.sessionId.trim()) continue;
    const expectedReason = NORMAL_CLOSE_REASONS.get(session.closeReason);
    const normal = expectedReason && (session.closeReasonText === undefined || session.closeReasonText === expectedReason);
    if (!normal || !Number.isSafeInteger(session.startTime) || !Number.isSafeInteger(session.endTime)
        || session.startTime <= 0 || session.endTime < session.startTime || session.endTime > timestamp) {
      // Conflicting records for one session cannot establish normal usage.
      sessions.set(session.sessionId, null);
      continue;
    }
    const milliseconds = Math.max(0, session.endTime - Math.max(dayStart, session.startTime));
    if (!sessions.has(session.sessionId)) sessions.set(session.sessionId, milliseconds);
    else if (sessions.get(session.sessionId) !== null) {
      sessions.set(session.sessionId, Math.min(sessions.get(session.sessionId), milliseconds));
    }
  }
  let milliseconds = 0;
  for (const duration of sessions.values()) {
    if (duration > 0) {
      summary.normalClosedSessionsToday++;
      milliseconds += duration;
    }
  }
  summary.normalClosedSecondsToday = milliseconds / 1000;
  return summary;
}
