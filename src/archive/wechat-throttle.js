import { CollectorError } from './collector-security.js';

export const REQUEST_INTERVAL_MS = 10_000;
export const SOURCE_COOLDOWN_MS = 15 * 60_000;

function configurationError() {
  return new CollectorError('CONFIG_MISSING', '微信请求节流数据库尚未初始化，请执行数据库迁移');
}

/** The singleton account clock is shared across every Worker and job executor. */
export class WechatThrottle {
  constructor(db, now = Date.now) { this.db = db; this.now = now; }

  timestamp() {
    if (!this.db?.prepare) throw new CollectorError('CONFIG_MISSING', '尚未配置微信请求节流数据库');
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > Number.MAX_SAFE_INTEGER - SOURCE_COOLDOWN_MS) {
      throw new CollectorError('CONFIG_INVALID', '微信请求节流时钟无效');
    }
    return timestamp;
  }

  async first(sql, values = []) {
    try { return await this.db.prepare(sql).bind(...values).first(); }
    catch (error) {
      if (/no such table:\s*archive_wechat_throttle/i.test(String(error?.message || ''))) throw configurationError();
      throw error;
    }
  }

  async reserve() {
    const timestamp = this.timestamp();
    const reserved = await this.first(`UPDATE archive_wechat_throttle
      SET next_allowed_at=?,updated_at=MAX(updated_at,?)
      WHERE singleton=1 AND next_allowed_at<=? RETURNING next_allowed_at`,
    [timestamp + REQUEST_INTERVAL_MS, timestamp, timestamp]);
    if (reserved) return { next_allowed_at: reserved.next_allowed_at };
    const current = await this.first('SELECT next_allowed_at FROM archive_wechat_throttle WHERE singleton=1');
    if (!current) throw configurationError();
    const error = new CollectorError('RATE_LIMITED', '微信请求正在等待，请稍后重试', true);
    error.status = 429;
    error.retry_at = current.next_allowed_at;
    error.transport = 'http';
    error.diagnostic = 'wechat_http: local_cooldown';
    throw error;
  }

  async cooldown() {
    const timestamp = this.timestamp();
    const current = await this.first(`UPDATE archive_wechat_throttle
      SET next_allowed_at=MAX(next_allowed_at,?),updated_at=MAX(updated_at,?)
      WHERE singleton=1 RETURNING next_allowed_at`, [timestamp + SOURCE_COOLDOWN_MS, timestamp]);
    if (!current) throw configurationError();
    return { next_allowed_at: current.next_allowed_at };
  }
}
