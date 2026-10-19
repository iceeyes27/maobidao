import { CollectorError } from './collector-security.js';

const AAD = new TextEncoder().encode('archive-wechat-session:v1');
const LOGIN_TTL = 10 * 60 * 1000;

function encode64(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function decode64(value) {
  try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  catch { throw new CollectorError('CONFIG_INVALID', 'ARCHIVE_SESSION_KEY 必须为 32 字节密钥的 Base64 编码'); }
}

export async function sessionCryptoKey(env) {
  if (!env.ARCHIVE_SESSION_KEY) throw new CollectorError('CONFIG_MISSING', '请配置 ARCHIVE_SESSION_KEY 后再连接微信账号');
  const bytes = decode64(env.ARCHIVE_SESSION_KEY);
  if (bytes.length !== 32) throw new CollectorError('CONFIG_INVALID', 'ARCHIVE_SESSION_KEY 必须为 32 字节密钥的 Base64 编码');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSession(value, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD }, key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({ format: 1, iv: encode64(iv), ciphertext: encode64(new Uint8Array(ciphertext)) });
}

export async function decryptSession(value, key) {
  try {
    const encrypted = JSON.parse(value);
    if (encrypted.format !== 1) throw new Error('Unknown format');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode64(encrypted.iv), additionalData: AAD }, key, decode64(encrypted.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new CollectorError('CONFIG_INVALID', '保存的微信登录状态无法解密，请核对密钥或重新登录');
  }
}

function changed(result) { return Number(result?.meta?.changes || 0) === 1; }

/** Only opaque browser IDs and encrypted storage state cross workflow boundaries. */
export class SessionStore {
  constructor(env, now = () => Date.now()) { this.env = env; this.now = now; }
  async ready() {
    if (!this.env.ARCHIVE_DB || !this.env.ARCHIVE_BUCKET) {
      throw new CollectorError('CONFIG_MISSING', '请配置 ARCHIVE_DB 和 ARCHIVE_BUCKET');
    }
    this.key ||= await sessionCryptoKey(this.env);
    return this;
  }
  async current() {
    await this.ready();
    const row = await this.env.ARCHIVE_DB.prepare('SELECT * FROM archive_session WHERE singleton = 1').first();
    if (!row) throw new CollectorError('CONFIG_MISSING', '采集数据库尚未初始化，请先运行数据库迁移');
    return row;
  }
  async load() {
    const row = await this.current();
    if (!row.object_key) throw new CollectorError('LOGIN_REQUIRED', '请先通过管理员页面扫码连接微信账号');
    const object = await this.env.ARCHIVE_BUCKET.get(row.object_key);
    if (!object) throw new CollectorError('LOGIN_EXPIRED', '保存的微信登录状态已失效，请重新扫码');
    const saved = await decryptSession(await object.text(), this.key);
    if (saved.version !== row.version || !Array.isArray(saved.storageState?.cookies)) {
      throw new CollectorError('LOGIN_EXPIRED', '微信登录状态版本无效，请重新扫码');
    }
    this.loadedObjectKey = row.object_key;
    this.loadedLoginId = saved.loginId || null;
    return { version: row.version, storageState: saved.storageState };
  }
  async beginLogin({ purpose = 'account', target_url = null } = {}) {
    const current = await this.current();
    if (current.active_login_id) {
      const active = await this.env.ARCHIVE_DB.prepare('SELECT * FROM archive_login WHERE id = ?').bind(current.active_login_id).first();
      if (active && active.expires_at > this.now() && ['creating', 'waiting'].includes(active.status)) {
        if (active.purpose !== purpose || active.target_url !== target_url) {
          throw new CollectorError('LOGIN_BUSY', '已有另一个微信验证任务，请先完成当前验证');
        }
        return { ...active, existing: true };
      }
    }
    const id = crypto.randomUUID();
    const now = this.now();
    const expires = now + LOGIN_TTL;
    await this.env.ARCHIVE_DB.prepare(
      "INSERT INTO archive_login (id,browser_session_id,status,version,created_at,expires_at,live_view_url,purpose,target_url) VALUES (?,?,'creating',?,?,?,NULL,?,?)",
    ).bind(id, '', current.version, now, expires, purpose, target_url).run();
    const result = await this.env.ARCHIVE_DB.prepare(
      'UPDATE archive_session SET active_login_id = ?, updated_at = ? WHERE singleton = 1 AND version = ? AND (active_login_id IS NULL OR active_login_id IN (SELECT id FROM archive_login WHERE expires_at <= ?))',
    ).bind(id, now, current.version, now).run();
    if (!changed(result)) {
      await this.mark(id, 'stale');
      const latest = await this.current();
      if (latest.active_login_id) {
        const active = await this.env.ARCHIVE_DB.prepare('SELECT * FROM archive_login WHERE id = ?').bind(latest.active_login_id).first();
        if (active && active.expires_at > this.now() && active.purpose === purpose && active.target_url === target_url) return { ...active, existing: true };
      }
      throw new CollectorError('LOGIN_BUSY', '微信登录状态正在更新，请稍后重新打开扫码入口', true);
    }
    return { id, version: current.version, expires_at: expires, purpose, target_url };
  }
  async attachBrowser(login, browserId, liveViewUrl) {
    const result = await this.env.ARCHIVE_DB.prepare(
      "UPDATE archive_login SET browser_session_id = ?, live_view_url = ?, status = 'waiting' WHERE id = ? AND status = 'creating' AND expires_at > ?",
    ).bind(browserId, liveViewUrl, login.id, this.now()).run();
    if (!changed(result)) throw new CollectorError('LOGIN_STALE', '扫码任务已失效，请重新创建');
  }
  async get(id) {
    await this.ready();
    if (!/^[0-9a-f-]{36}$/i.test(id || '')) throw new CollectorError('LOGIN_EXPIRED', '扫码任务不存在或已过期');
    const row = await this.env.ARCHIVE_DB.prepare('SELECT * FROM archive_login WHERE id = ?').bind(id).first();
    if (!row) throw new CollectorError('LOGIN_EXPIRED', '扫码任务不存在或已过期');
    const current = await this.current();
    if (row.status === 'authenticated') {
      if (current.version !== row.version || current.active_login_id) throw new CollectorError('LOGIN_STALE', '该登录确认已被较新的状态替代');
      if (row.expires_at <= this.now()) throw new CollectorError('LOGIN_EXPIRED', '该登录确认已过期');
      return row;
    }
    if (row.status === 'waiting' && current.object_key && current.version > row.version && current.active_login_id === null) {
      const object = await this.env.ARCHIVE_BUCKET.get(current.object_key);
      const saved = object && await decryptSession(await object.text(), this.key);
      if (saved?.loginId === row.id) {
        await this.env.ARCHIVE_DB.prepare("UPDATE archive_login SET status = 'authenticated', version = ?, live_view_url = NULL WHERE id = ?")
          .bind(saved.version, row.id).run();
        return { ...row, status: 'authenticated', version: saved.version, live_view_url: null };
      }
    }
    if (current.active_login_id !== row.id || current.version !== row.version) {
      throw new CollectorError('LOGIN_STALE', '该二维码已被新的登录任务替代');
    }
    if (row.expires_at <= this.now() || ['expired', 'failed', 'stale'].includes(row.status)) {
      throw new CollectorError('LOGIN_EXPIRED', '扫码入口已过期，请重新创建');
    }
    return row;
  }
  async mark(id, status) {
    if (!['expired', 'failed', 'stale'].includes(status)) throw new CollectorError('LOGIN_STATE_INVALID', '扫码任务状态无效');
    const results = await this.env.ARCHIVE_DB.batch([
      this.env.ARCHIVE_DB.prepare("UPDATE archive_login SET status = ? WHERE id = ? AND status IN ('creating','waiting')")
        .bind(status, id),
      // An old poll cannot expire a completed login or release a newer task.
      // This also repairs an interrupted release of an already expired task.
      this.env.ARCHIVE_DB.prepare(`UPDATE archive_session SET active_login_id = NULL WHERE singleton = 1 AND active_login_id = ?
        AND EXISTS (SELECT 1 FROM archive_login WHERE id = ? AND status IN ('expired','failed','stale'))`)
        .bind(id, id),
    ]);
    return changed(results[0]);
  }
  async save(storageState, expectedVersion, loginId = null) {
    await this.ready();
    if (!loginId && !this.loadedObjectKey) throw new CollectorError('LOGIN_STALE', '保存登录状态前必须先读取当前版本');
    // A version identifies a human-verified login generation. Rotating cookies
    // must not invalidate an already queued workflow recovery event.
    const version = loginId ? expectedVersion + 1 : expectedVersion;
    const objectKey = `private/wechat-state/${version}-${crypto.randomUUID()}.json`;
    const encrypted = await encryptSession({ version, storageState, loginId: loginId || this.loadedLoginId }, this.key);
    await this.env.ARCHIVE_BUCKET.put(objectKey, encrypted, { httpMetadata: { contentType: 'application/json' } });
    // Object versions are immutable; a stale writer can never overwrite a newer login.
    const where = loginId ? 'active_login_id = ?' : 'active_login_id IS NULL AND object_key = ?';
    const args = [version, objectKey, this.now(), expectedVersion, loginId || this.loadedObjectKey];
    let result;
    try {
      const update = this.env.ARCHIVE_DB.prepare(
        `UPDATE archive_session SET version = ?, object_key = ?, updated_at = ?, active_login_id = NULL WHERE singleton = 1 AND version = ? AND ${where}`,
      ).bind(...args);
      if (loginId) {
        const results = await this.env.ARCHIVE_DB.batch([
          update,
          this.env.ARCHIVE_DB.prepare("UPDATE archive_login SET status = 'authenticated', version = ?, live_view_url = NULL WHERE id = ? AND EXISTS (SELECT 1 FROM archive_session WHERE singleton = 1 AND object_key = ? AND version = ?)")
            .bind(version, loginId, objectKey, version),
        ]);
        result = results[0];
      } else { result = await update.run(); }
    } catch (error) {
      // Do not delete after an ambiguous DB response: the CAS may have committed.
      const current = await this.current().catch(() => null);
      if (current?.object_key !== objectKey) throw error;
      result = { meta: { changes: 1 } };
    }
    if (!changed(result)) {
      await this.env.ARCHIVE_BUCKET.delete(objectKey);
      throw new CollectorError('LOGIN_STALE', '登录状态已更新，本次旧状态不再保存');
    }
    this.loadedObjectKey = objectKey;
    this.loadedLoginId = loginId || this.loadedLoginId;
    return version;
  }
}
