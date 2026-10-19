import { sourceArticleKey, stableId } from './core.js';

const INACTIVE_JOBS = "'paused','cancelled','completed','partial_failed','failed'";
const ACTIVE_ARTICLE_JOB = `EXISTS (
  SELECT 1 FROM archive_job_items item JOIN archive_jobs job ON job.id = item.job_id
  WHERE item.article_id = archive_articles.id AND item.status != 'cancelled'
    AND job.status NOT IN ('cancelled','completed','partial_failed','failed')
)`;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw fail(`${name} is required`);
  return value.trim();
}

function timestamp(value, name, nullable = true) {
  if (value == null && nullable) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw fail(`${name} must be UTC milliseconds`);
  return value;
}

function encode(value) { return JSON.stringify(value ?? null); }
function decode(value, fallback) {
  if (value == null) return fallback;
  return JSON.parse(value);
}

function rowObject(row) {
  if (!row) return null;
  const result = { ...row };
  for (const [column, fallback] of [
    ['urls_json', []], ['cursor_json', null], ['progress_json', {}],
    ['manifest_json', []], ['metadata_json', {}],
  ]) {
    if (column in result) {
      result[column.slice(0, -5)] = decode(result[column], fallback);
      delete result[column];
    }
  }
  if ('enabled' in result) result.enabled = Boolean(result.enabled);
  if ('legacy_fallback' in result) result.legacy_fallback = Boolean(result.legacy_fallback);
  delete result.idempotency_key;
  delete result.request_fingerprint;
  return result;
}

function boundedLimit(value, fallback = 30, maximum = 200) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1) throw fail('limit must be a positive integer');
  return Math.min(number, maximum);
}

function articleKey(data) {
  return required(data.source_key || data.article_key || sourceArticleKey(data.url), 'source_key');
}

function sourceTimestamp(data) {
  return timestamp(data.first_published_at ?? data.published_at, 'first_published_at');
}

function articleMetadata(data) {
  const metadata = { ...(data.metadata || {}) };
  for (const field of ['author', 'source_name', 'source_host', 'time_trusted']) {
    if (data[field] !== undefined) metadata[field] = data[field];
  }
  return metadata;
}

function leaseConditions(token, resource, now) {
  if (!token || token.resource !== resource || !Number.isSafeInteger(token.generation)) {
    throw fail('A matching lease token is required', 409);
  }
  return [token.resource, token.owner, token.generation, now];
}

function manifestEntries(manifest) {
  const entries = Array.isArray(manifest) ? manifest : manifest?.images;
  if (!Array.isArray(entries)) throw fail('manifest must contain an image array');
  const keys = new Set();
  return entries.map((entry) => {
    const item = typeof entry === 'string' ? { key: entry } : entry;
    const key = required(item?.key, 'manifest key');
    if (keys.has(key)) throw fail('manifest contains duplicate keys');
    keys.add(key);
    return { ...item, key };
  });
}

function preferredArticle(first, second) {
  if (!second || first.id === second.id) return first;
  const rank = (article) => {
    if (article.status === 'published') return article.legacy_fallback ? 4 : 3;
    if (article.captured_at != null || article.status === 'ready') return 2;
    return 1;
  };
  return [first, second].sort((a, b) => rank(b) - rank(a)
    || Number(b.legacy_fallback) - Number(a.legacy_fallback)
    || a.created_at - b.created_at || a.id.localeCompare(b.id))[0];
}

export class ArchiveStore {
  constructor(db) { this.db = db; }

  statement(sql, values = []) { return this.db.prepare(sql).bind(...values); }
  async first(sql, values = []) { return rowObject(await this.statement(sql, values).first()); }
  async all(sql, values = []) {
    const result = await this.statement(sql, values).all();
    return result.results.map(rowObject);
  }

  async initSource({ name, fakeid, account_biz = null }) {
    name = required(name, 'name');
    fakeid = required(fakeid, 'fakeid');
    const id = await stableId(`source:${fakeid}`);
    const now = Date.now();
    await this.statement(`INSERT INTO archive_sources
      (id,name,fakeid,account_biz,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(fakeid) DO UPDATE SET name=excluded.name,
        account_biz=COALESCE(excluded.account_biz,archive_sources.account_biz),updated_at=excluded.updated_at`,
    [id, name, fakeid, account_biz, now, now]).run();
    return this.getSource(id);
  }

  listSources() { return this.all('SELECT * FROM archive_sources ORDER BY created_at,id'); }
  getSource(id) { return this.first('SELECT * FROM archive_sources WHERE id=?', [id]); }

  async updateSource(id, patch) {
    const allowed = new Set(['name', 'account_biz', 'enabled']);
    const updates = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) throw fail(`Unsupported source field: ${key}`);
      if (key === 'enabled' && typeof value !== 'boolean') throw fail('enabled must be boolean');
      if (key === 'name') required(value, 'name');
      updates.push(`${key}=?`);
      values.push(key === 'enabled' ? Number(Boolean(value)) : value);
    }
    if (!updates.length) return this.getSource(id);
    await this.statement(`UPDATE archive_sources SET ${updates.join(',')},updated_at=? WHERE id=?`,
      [...values, Date.now(), id]).run();
    return this.getSource(id);
  }

  async completeBaseline(sourceId, articles, activatedAtMs = Date.now()) {
    timestamp(activatedAtMs, 'activatedAtMs', false);
    const source = await this.getSource(sourceId);
    if (!source) throw fail('Source not found', 404);
    if (source.baseline_completed_at != null) return source;
    const keys = [...new Set(articles.map((data) => typeof data === 'string' ? data : articleKey(data)))];
    const statements = keys.map((key) => this.statement(`INSERT OR IGNORE INTO archive_source_baseline(source_id,source_key)
      SELECT ?,? WHERE EXISTS (SELECT 1 FROM archive_sources WHERE id=? AND baseline_completed_at IS NULL)`,
    [sourceId, key, sourceId]));
    statements.push(this.statement(`UPDATE archive_sources SET baseline_completed_at=?,activated_at=?,updated_at=?
      WHERE id=? AND baseline_completed_at IS NULL`, [Date.now(), activatedAtMs, Date.now(), sourceId]));
    await this.db.batch(statements);
    return this.getSource(sourceId);
  }

  async isBaselineArticle(sourceId, key) {
    return Boolean(await this.first('SELECT source_key FROM archive_source_baseline WHERE source_id=? AND source_key=?', [sourceId, key]));
  }

  async createJob(input, idempotencyKey = null) {
    if (!['baseline', 'history', 'manual', 'auto'].includes(input.kind)) throw fail('Unsupported job kind');
    const payload = {
      kind: input.kind, source_id: input.source_id || null,
      range_start: timestamp(input.range_start, 'range_start'),
      range_end: timestamp(input.range_end, 'range_end'),
      urls: [...new Set((input.urls || []).map((url) => required(url, 'url')))],
      monitor_date: input.monitor_date || null, article_key: input.article_key || null,
    };
    if (payload.range_start != null && payload.range_end != null && payload.range_start >= payload.range_end) {
      throw fail('range_end must be after range_start');
    }
    if (input.kind === 'history' && (!payload.source_id || payload.range_start == null || payload.range_end == null)) {
      throw fail('History jobs require a source and frozen time range');
    }
    if (input.kind === 'manual' && !payload.urls.length) throw fail('Manual jobs require article URLs');
    if (input.kind === 'auto' && (!payload.source_id || !/^\d{4}-\d{2}-\d{2}$/.test(payload.monitor_date || ''))) {
      throw fail('Automatic jobs require a source and monitor_date');
    }
    if (input.kind === 'baseline' && !payload.source_id) throw fail('Baseline jobs require a source');
    const fingerprint = await stableId(encode(payload));
    const id = idempotencyKey ? await stableId(`job:${required(idempotencyKey, 'idempotencyKey')}`) : crypto.randomUUID();
    const workflowId = `archive-${id}`;
    const now = Date.now();
    await this.db.batch([
      this.statement(`INSERT OR IGNORE INTO archive_jobs
        (id,kind,source_id,range_start,range_end,urls_json,monitor_date,article_key,workflow_id,idempotency_key,request_fingerprint,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, payload.kind, payload.source_id, payload.range_start, payload.range_end, encode(payload.urls),
        payload.monitor_date, payload.article_key, workflowId, idempotencyKey || null, fingerprint, now, now]),
      this.statement(`INSERT OR IGNORE INTO archive_dispatch_outbox(job_id,workflow_id,created_at)
        SELECT id,workflow_id,? FROM archive_jobs WHERE id=?`, [now, id]),
    ]);
    const stored = await this.statement('SELECT * FROM archive_jobs WHERE id=?', [id]).first();
    if (stored.request_fingerprint !== fingerprint) throw fail('Idempotency key was used for another request', 409);
    return rowObject(stored);
  }

  getJob(id) { return this.first('SELECT * FROM archive_jobs WHERE id=?', [id]); }
  listJobs(limit = 30) {
    return this.all('SELECT * FROM archive_jobs ORDER BY created_at DESC,id DESC LIMIT ?', [boundedLimit(limit)]);
  }
  getJobItems(id) {
    return this.all(`SELECT item.*, article.source_key,article.url,article.title,article.status AS article_status,
      article.body_key,article.captured_at,article.published_at FROM archive_job_items item
      JOIN archive_articles article ON article.id=item.article_id WHERE item.job_id=? ORDER BY item.created_at,item.article_id`, [id]);
  }

  async updateJob(id, patch) {
    const allowed = new Set(['status', 'cursor', 'progress', 'discovered_count', 'completed_count', 'failed_count', 'last_error', 'next_retry_at']);
    const updates = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) throw fail(`Unsupported job field: ${key}`);
      if (key.endsWith('_count') && (!Number.isSafeInteger(value) || value < 0)) throw fail(`${key} must be nonnegative`);
      if (key === 'next_retry_at') timestamp(value, key);
      const json = key === 'cursor' || key === 'progress';
      updates.push(`${key}${json ? '_json' : ''}=?`);
      values.push(json ? encode(value) : value);
    }
    const changingStatus = 'status' in patch && patch.status !== 'paused';
    const terminalGuard = changingStatus ? "AND status!='paused' AND (status NOT IN ('completed','partial_failed') OR status=?)" : '';
    if (updates.length) await this.statement(`UPDATE archive_jobs SET ${updates.join(',')},updated_at=?
      WHERE id=? AND status!='cancelled' ${terminalGuard}`,
    [...values, Date.now(), id, ...(changingStatus ? [patch.status] : [])]).run();
    return this.getJob(id);
  }

  async scheduleJob(jobId, window) {
    const now = Date.now();
    return this.first(`UPDATE archive_jobs SET status='queued',
      progress_json=json_set(progress_json,'$.dispatch_window',json(?)),next_retry_at=NULL,updated_at=?
      WHERE id=? AND status NOT IN ('completed','partial_failed','failed','cancelled','paused','waiting_auth')
        AND COALESCE(next_retry_at,0)<=?
        AND COALESCE(json_extract(progress_json,'$.quota_wait_until'),0)<=?
      RETURNING *`, [encode(window), now, jobId, now, now]);
  }

  async patchJobProgress(jobId, patch, options = {}) {
    let progress = 'progress_json';
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) throw fail('Invalid progress field');
      progress = `json_set(${progress},?,json(?))`;
      values.push(`$.${key}`, encode(value));
    }
    const updates = [];
    for (const [key, value] of Object.entries(options)) {
      if (key === 'scannedPage') {
        if (typeof value !== 'boolean') throw fail('scannedPage must be boolean');
        if (value) progress = `json_set(${progress},'$.scanned_pages',
          CASE WHEN json_type(progress_json,'$.scanned_pages')='integer'
            AND json_extract(progress_json,'$.scanned_pages')>=0
            THEN json_extract(progress_json,'$.scanned_pages')+1 ELSE 1 END)`;
        continue;
      }
      if (!['cursor', 'status', 'last_error'].includes(key)) throw fail(`Unsupported checkpoint field: ${key}`);
      // In-flight page completion can preserve its cursor while an administrator pauses the job.
      updates.push(key === 'status' ? "status=CASE WHEN status='paused' THEN status ELSE ? END"
        : `${key === 'cursor' ? 'cursor_json' : key}=?`);
    }
    const optionValues = Object.entries(options).filter(([key]) => key !== 'scannedPage')
      .map(([key, value]) => key === 'cursor' ? encode(value) : value);
    const updated = await this.first(`UPDATE archive_jobs SET progress_json=${progress},
      ${updates.length ? `${updates.join(',')},` : ''}updated_at=?
      WHERE id=? AND status NOT IN ('cancelled','completed','partial_failed') RETURNING *`,
    [...values, ...optionValues, Date.now(), jobId]);
    return updated || this.getJob(jobId);
  }

  async addJobArticle(jobId, data) {
    const job = await this.getJob(jobId);
    if (!job) throw fail('Job not found', 404);
    if (job.status === 'cancelled') throw fail('Job is cancelled', 409);
    const key = articleKey(data);
    const urlKey = sourceArticleKey(data.url);
    const identityTokens = [];
    try {
      for (const identity of [...new Set([key, urlKey])].sort()) {
        const token = await this.acquireLease(`identity:${identity}`, crypto.randomUUID(), 30_000);
        if (!token) throw fail('Article identity is being resolved; retry the task', 409);
        identityTokens.push(token);
      }
      const existing = await this.getArticleByKey(key) || await this.getArticleByKey(urlKey);
      const id = existing?.id || await stableId(key);
      const now = Date.now();
      await this.db.batch([
        this.statement(`INSERT OR IGNORE INTO archive_articles
          (id,source_key,source_id,url,title,account_name,publish_time,first_published_at,metadata_json,created_at,updated_at)
          SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM archive_jobs WHERE id=? AND status!='cancelled')`,
        [id, key, data.source_id || job.source_id, required(data.url, 'url'), data.title || '', data.account_name || '',
          data.publish_time || '', sourceTimestamp(data), encode(articleMetadata(data)), now, now, jobId]),
        this.statement(`INSERT OR IGNORE INTO archive_article_aliases(alias_key,article_id,url)
          SELECT ?,id,? FROM archive_articles WHERE id=?`, [key, data.url, id]),
        this.statement(`INSERT OR IGNORE INTO archive_article_aliases(alias_key,article_id,url)
          SELECT ?,id,? FROM archive_articles WHERE id=?`, [urlKey, data.url, id]),
        this.statement(`INSERT OR IGNORE INTO archive_job_items(job_id,article_id,status,created_at,updated_at)
          SELECT ?,id,CASE WHEN status='published' THEN 'completed' ELSE 'pending' END,?,?
          FROM archive_articles WHERE id=? AND EXISTS(SELECT 1 FROM archive_jobs WHERE id=? AND status!='cancelled')`,
        [jobId, now, now, id, jobId]),
      ]);
      const article = await this.getArticleByKey(key);
      const item = article && await this.first('SELECT * FROM archive_job_items WHERE job_id=? AND article_id=?', [jobId, article.id]);
      if (!item) throw fail('Job was cancelled', 409);
      return { article, item };
    } finally {
      for (const token of identityTokens) await this.releaseLease(token);
    }
  }

  getArticle(id) {
    return this.first(`SELECT * FROM archive_articles WHERE id=? OR id=(
      SELECT article_id FROM archive_article_aliases WHERE alias_id=?) LIMIT 1`, [id, id]);
  }
  getArticleByKey(key) {
    return this.first(`SELECT * FROM archive_articles WHERE source_key=? OR id=(
      SELECT article_id FROM archive_article_aliases WHERE alias_key=?) LIMIT 1`, [key, key]);
  }

  async resolveArticleIdentity(id, key, url) {
    key = required(key, 'source_key');
    url = required(url, 'url');
    const identityLease = await this.acquireLease(`identity:${key}`, crypto.randomUUID(), 30_000);
    if (!identityLease) throw fail('Article identity is being resolved', 409);
    try {
      const current = await this.getArticle(id);
      if (!current) throw fail('Article not found', 404);
      const other = await this.getArticleByKey(key);
      const winner = preferredArticle(current, other);
      const loser = other && other.id !== current.id ? (winner.id === current.id ? other : current) : null;
      const now = Date.now();
      const statements = [];
      if (loser) {
        statements.push(
          this.statement(`INSERT INTO archive_job_items(job_id,article_id,status,attempts,attempt_window,last_error,created_at,updated_at)
            SELECT job_id,?,CASE WHEN ?='published' THEN 'completed' ELSE status END,attempts,attempt_window,last_error,created_at,?
            FROM archive_job_items WHERE article_id=?
            ON CONFLICT(job_id,article_id) DO UPDATE SET
              status=CASE WHEN excluded.status='completed' THEN 'completed' ELSE archive_job_items.status END,
              attempts=MAX(archive_job_items.attempts,excluded.attempts),
              attempt_window=COALESCE(excluded.attempt_window,archive_job_items.attempt_window),
              updated_at=excluded.updated_at`, [winner.id, winner.status, now, loser.id]),
          this.statement('DELETE FROM archive_job_items WHERE article_id=?', [loser.id]),
          this.statement('UPDATE archive_article_aliases SET article_id=? WHERE article_id=?', [winner.id, loser.id]),
          this.statement(`INSERT OR IGNORE INTO archive_article_aliases(alias_key,article_id,alias_id,url)
            VALUES (?,?,?,?)`, [`legacy-id:${loser.id}`, winner.id, loser.id, loser.url]),
          this.statement('DELETE FROM archive_leases WHERE resource=?', [`article:${loser.id}`]),
          this.statement('DELETE FROM archive_articles WHERE id=?', [loser.id]),
        );
      }
      for (const alias of new Set([current.source_key, other?.source_key, key, sourceArticleKey(url)].filter(Boolean))) {
        statements.push(this.statement(`INSERT INTO archive_article_aliases(alias_key,article_id,url) VALUES (?,?,?)
          ON CONFLICT(alias_key) DO UPDATE SET article_id=excluded.article_id,url=excluded.url`, [alias, winner.id, url]));
      }
      statements.push(
        this.statement('UPDATE archive_articles SET source_key=?,updated_at=? WHERE id=?', [key, now, winner.id]),
        this.statement('UPDATE archive_jobs SET article_key=?,updated_at=? WHERE article_key IN (?,?)',
          [key, now, current.source_key, other?.source_key || current.source_key]),
        this.statement('UPDATE archive_daily_runs SET selected_article_key=?,updated_at=? WHERE selected_article_key IN (?,?)',
          [key, now, current.source_key, other?.source_key || current.source_key]),
        this.statement(`INSERT OR IGNORE INTO archive_source_baseline(source_id,source_key)
          SELECT source_id,? FROM archive_source_baseline WHERE source_key IN (?,?)`,
        [key, current.source_key, other?.source_key || current.source_key]),
      );
      await this.db.batch(statements);
      return this.getArticle(winner.id);
    } finally {
      await this.releaseLease(identityLease);
    }
  }
  listPublished({ limit = 100, offset = 0 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw fail('offset must be nonnegative');
    return this.all(`SELECT * FROM archive_articles WHERE status='published'
      ORDER BY COALESCE(first_published_at,created_at) DESC,id DESC LIMIT ? OFFSET ?`, [boundedLimit(limit, 100), offset]);
  }

  async acquireLease(resource, owner, ttlMs) {
    resource = required(resource, 'resource');
    owner = required(owner, 'owner');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw fail('ttlMs must be positive');
    const now = Date.now();
    timestamp(now + ttlMs, 'expires_at', false);
    return this.first(`INSERT INTO archive_leases(resource,owner,generation,expires_at,updated_at) VALUES (?,?,1,?,?)
      ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,generation=archive_leases.generation+1,
        expires_at=excluded.expires_at,updated_at=excluded.updated_at
      WHERE archive_leases.expires_at<=? RETURNING resource,owner,generation,expires_at`,
    [resource, owner, now + ttlMs, now, now]);
  }

  async renewLease(token, ttlMs) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw fail('ttlMs must be positive');
    const now = Date.now();
    timestamp(now + ttlMs, 'expires_at', false);
    const conditions = leaseConditions(token, token?.resource, now);
    return this.first(`UPDATE archive_leases SET expires_at=?,updated_at=?
      WHERE resource=? AND owner=? AND generation=? AND expires_at>? RETURNING resource,owner,generation,expires_at`,
    [now + ttlMs, now, ...conditions]);
  }

  async releaseLease(token) {
    leaseConditions(token, token?.resource, Date.now());
    const result = await this.statement(`UPDATE archive_leases SET expires_at=0,updated_at=?
      WHERE resource=? AND owner=? AND generation=?`, [Date.now(), token.resource, token.owner, token.generation]).run();
    return result.meta.changes > 0;
  }

  async claimArticle(id, owner, ttlMs) {
    const article = await this.getArticle(id);
    if (!article || article.status === 'published') return null;
    const active = await this.first(`SELECT id FROM archive_articles WHERE id=? AND ${ACTIVE_ARTICLE_JOB}
      AND EXISTS(SELECT 1 FROM archive_job_items item JOIN archive_jobs job ON job.id=item.job_id
        WHERE item.article_id=archive_articles.id AND job.status NOT IN (${INACTIVE_JOBS}) AND item.status!='cancelled')`, [article.id]);
    if (!active) return null;
    const token = await this.acquireLease(`article:${article.id}`, owner, ttlMs);
    if (!token) return null;
    const claimed = await this.patchArticle(article.id, { status: article.captured_at == null ? 'capturing' : 'ready' }, token);
    if (claimed) return token;
    await this.releaseLease(token);
    return null;
  }

  async patchArticle(id, patch, token) {
    const allowed = new Set(['status', 'title', 'account_name', 'publish_time', 'first_published_at', 'body_key',
      'manifest', 'metadata', 'content_text', 'summary', 'captured_at', 'last_error']);
    const updates = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) throw fail(`Unsupported article field: ${key}`);
      if (key === 'status' && value === 'published') throw fail('Use publishArticle to publish');
      if (key === 'first_published_at' || key === 'captured_at') timestamp(value, key);
      const json = key === 'manifest' || key === 'metadata';
      updates.push(`${key}${json ? '_json' : ''}=?`);
      values.push(json ? encode(key === 'manifest' ? manifestEntries(value) : value) : value);
    }
    if (!updates.length) throw fail('Article patch is empty');
    const now = Date.now();
    const conditions = leaseConditions(token, `article:${id}`, now);
    return this.first(`UPDATE archive_articles SET ${updates.join(',')},updated_at=? WHERE id=? AND status!='published'
      AND ${ACTIVE_ARTICLE_JOB} AND EXISTS(SELECT 1 FROM archive_leases
        WHERE resource=? AND owner=? AND generation=? AND expires_at>?) RETURNING *`, [...values, now, id, ...conditions]);
  }

  async publishArticle(id, data, token) {
    const now = Date.now();
    const conditions = leaseConditions(token, `article:${id}`, now);
    const bodyKey = required(data.body_key, 'body_key');
    const manifest = manifestEntries(data.manifest);
    const article = await this.getArticle(id);
    if (!article) return null;
    const patch = {
      title: data.title ?? article.title, account_name: data.account_name ?? article.account_name,
      publish_time: data.publish_time ?? article.publish_time,
      first_published_at: timestamp(data.first_published_at ?? article.first_published_at, 'first_published_at'),
      body_key: bodyKey, manifest: encode(manifest), metadata: encode(data.metadata ?? article.metadata),
      content_text: data.content_text ?? article.content_text, summary: data.summary ?? article.summary,
      captured_at: timestamp(data.captured_at ?? article.captured_at ?? now, 'captured_at', false),
    };
    return this.first(`UPDATE archive_articles SET title=?,account_name=?,publish_time=?,first_published_at=?,body_key=?,
      manifest_json=?,metadata_json=?,content_text=?,summary=?,captured_at=?,published_at=?,status='published',last_error=NULL,updated_at=?
      WHERE id=? AND status!='published' AND ${ACTIVE_ARTICLE_JOB}
      AND EXISTS(SELECT 1 FROM archive_leases WHERE resource=? AND owner=? AND generation=? AND expires_at>?) RETURNING *`,
    [...Object.values(patch), now, now, id, ...conditions]);
  }

  async updateJobItem(jobId, articleId, patch) {
    const allowed = new Set(['status', 'last_error', 'attempts', 'attempt_window']);
    const updates = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) throw fail(`Unsupported item field: ${key}`);
      if (key === 'attempts' && (!Number.isSafeInteger(value) || value < 0)) throw fail('attempts must be nonnegative');
      updates.push(`${key}=?`); values.push(value);
    }
    if (updates.length) await this.statement(`UPDATE archive_job_items SET ${updates.join(',')},updated_at=?
      WHERE job_id=? AND article_id=? AND EXISTS(SELECT 1 FROM archive_jobs WHERE id=? AND status!='cancelled')`,
    [...values, Date.now(), jobId, articleId, jobId]).run();
    return this.first('SELECT * FROM archive_job_items WHERE job_id=? AND article_id=?', [jobId, articleId]);
  }

  async setJobControl(jobId, action) {
    if (!['pause', 'resume', 'cancel', 'retry'].includes(action)) throw fail('Unsupported job action');
    const job = await this.getJob(jobId);
    if (!job) throw fail('Job not found', 404);
    if (job.status === 'cancelled') return job;
    if (job.status === 'completed' || job.status === 'partial_failed' && action !== 'retry') return job;
    if (action === 'pause' && ['completed', 'partial_failed', 'failed'].includes(job.status)) return job;
    if (action === 'resume' && job.status !== 'paused') return job;
    const now = Date.now();
    if (action === 'cancel') {
      await this.db.batch([
        this.statement("UPDATE archive_jobs SET status='cancelled',updated_at=? WHERE id=? AND status NOT IN ('completed','partial_failed')", [now, jobId]),
        this.statement(`UPDATE archive_job_items SET status='cancelled',updated_at=? WHERE job_id=? AND status!='completed'
          AND EXISTS(SELECT 1 FROM archive_jobs WHERE id=? AND status='cancelled')`, [now, jobId, jobId]),
      ]);
    } else if (action === 'pause') {
      await this.updateJob(jobId, { status: 'paused' });
    } else {
      await this.db.batch([
        this.statement(`UPDATE archive_jobs SET status='queued',last_error=NULL,next_retry_at=NULL,updated_at=?
          WHERE id=? AND status NOT IN ('cancelled','completed') ${action === 'resume' ? "AND status='paused'" : ''}`, [now, jobId]),
        this.statement(`INSERT INTO archive_dispatch_outbox(job_id,workflow_id,reason,created_at)
          SELECT id,workflow_id,?,? FROM archive_jobs WHERE id=? AND changes()>0
          ON CONFLICT(job_id) DO UPDATE SET generation=archive_dispatch_outbox.generation+1,
            reason=excluded.reason,dispatched_at=NULL`, [action, now, jobId]),
        ...(action === 'retry' ? [this.statement(`UPDATE archive_job_items SET status='pending',last_error=NULL,
          attempts=0,attempt_window=NULL,updated_at=? WHERE job_id=? AND status='failed'
          AND EXISTS(SELECT 1 FROM archive_jobs WHERE id=? AND status='queued')`, [now, jobId, jobId])] : []),
      ]);
    }
    return this.getJob(jobId);
  }

  listPendingDispatch() {
    return this.all(`SELECT job.*,dispatch.generation AS dispatch_generation,dispatch.reason AS dispatch_reason
      FROM archive_dispatch_outbox dispatch JOIN archive_jobs job ON job.id=dispatch.job_id
      WHERE (dispatch.dispatched_at IS NULL OR dispatch.generation>dispatch.dispatched_generation)
        AND job.status NOT IN (${INACTIVE_JOBS})
      ORDER BY CASE WHEN job.kind='auto' THEN 0 ELSE 1 END,job.created_at LIMIT 100`);
  }
  getDispatch(jobId) { return this.first('SELECT * FROM archive_dispatch_outbox WHERE job_id=?', [jobId]); }

  async requestDispatch(jobId, reason = 'resume') {
    if (!['start', 'resume', 'retry', 'continue', 'scheduled', 'auth'].includes(reason)) throw fail('Unsupported dispatch reason');
    const requested = await this.first(`INSERT INTO archive_dispatch_outbox(job_id,workflow_id,reason,created_at)
      SELECT id,workflow_id,?,? FROM archive_jobs WHERE id=? AND status NOT IN ('cancelled','completed','partial_failed')
      ON CONFLICT(job_id) DO UPDATE SET generation=archive_dispatch_outbox.generation+1,
        reason=excluded.reason,dispatched_at=NULL RETURNING *`, [reason, Date.now(), jobId]);
    return requested || this.getDispatch(jobId);
  }

  async markDispatched(jobId, workflowId, generation) {
    const expected = generation ?? (await this.getDispatch(jobId))?.generation;
    if (!Number.isSafeInteger(expected)) return false;
    const result = await this.statement(`UPDATE archive_dispatch_outbox SET dispatched_at=?,dispatched_generation=?
      WHERE job_id=? AND workflow_id=? AND generation=?`, [Date.now(), expected, jobId, workflowId, expected]).run();
    return result.meta.changes > 0;
  }

  getDaily(sourceId, monitorDate) {
    return this.first('SELECT * FROM archive_daily_runs WHERE source_id=? AND monitor_date=?', [sourceId, monitorDate]);
  }
  async ensureDaily(sourceId, monitorDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(monitorDate)) throw fail('Invalid monitor_date');
    const now = Date.now();
    await this.statement(`INSERT OR IGNORE INTO archive_daily_runs(source_id,monitor_date,created_at,updated_at)
      VALUES (?,?,?,?)`, [sourceId, monitorDate, now, now]).run();
    return this.getDaily(sourceId, monitorDate);
  }
  async selectDailyArticle(sourceId, monitorDate, key, jobId) {
    await this.ensureDaily(sourceId, monitorDate);
    await this.db.batch([
      this.statement(`UPDATE archive_jobs SET article_key=?,updated_at=? WHERE id=? AND kind='auto'
        AND source_id=? AND (article_key IS NULL OR article_key=?)
        AND (article_key IS NOT NULL OR EXISTS(SELECT 1 FROM archive_sources WHERE id=archive_jobs.source_id AND enabled=1))
        AND NOT EXISTS(SELECT 1 FROM archive_daily_runs WHERE monitor_date=? AND source_id!=?
          AND selected_article_key IS NOT NULL)
        AND EXISTS(SELECT 1 FROM archive_daily_runs WHERE source_id=? AND monitor_date=?
          AND (selected_article_key IS NULL OR (selected_article_key=? AND job_id=?)))`,
      [key, Date.now(), jobId, sourceId, key, monitorDate, sourceId, sourceId, monitorDate, key, jobId]),
      this.statement(`UPDATE archive_daily_runs SET selected_article_key=?,job_id=?,
        status=CASE WHEN selected_article_key IS NULL THEN 'selected' ELSE status END,updated_at=?
      WHERE source_id=? AND monitor_date=? AND (selected_article_key IS NULL OR (selected_article_key=? AND job_id=?))
        AND NOT EXISTS(SELECT 1 FROM archive_daily_runs other WHERE other.monitor_date=? AND other.source_id!=?
          AND other.selected_article_key IS NOT NULL)
        AND EXISTS(SELECT 1 FROM archive_jobs WHERE id=? AND kind='auto' AND source_id=? AND article_key=? AND status!='cancelled')`,
      [required(key, 'articleKey'), jobId, Date.now(), sourceId, monitorDate, key, jobId, monitorDate, sourceId, jobId, sourceId, key]),
    ]);
    const selected = await this.getDaily(sourceId, monitorDate);
    return selected.selected_article_key === key && selected.job_id === jobId ? selected : null;
  }
  async completeDaily(sourceId, monitorDate, patch = {}) {
    const allowed = new Set(['capture_completed_at', 'completed_at', 'status']);
    const updates = [];
    const values = [];
    const effective = Object.keys(patch).length ? patch : { capture_completed_at: Date.now(), completed_at: Date.now(), status: 'completed' };
    for (const [key, value] of Object.entries(effective)) {
      if (!allowed.has(key)) throw fail(`Unsupported daily field: ${key}`);
      updates.push(`${key}=?`); values.push(key.endsWith('_at') ? timestamp(value, key) : value);
    }
    const completing = effective.completed_at != null || effective.status === 'completed';
    return this.first(`UPDATE archive_daily_runs SET ${updates.join(',')},updated_at=?
      WHERE source_id=? AND monitor_date=? AND selected_article_key IS NOT NULL
        AND EXISTS(SELECT 1 FROM archive_articles article WHERE (article.source_key=archive_daily_runs.selected_article_key
          OR article.id=(SELECT article_id FROM archive_article_aliases WHERE alias_key=archive_daily_runs.selected_article_key))
          AND article.captured_at IS NOT NULL ${completing ? "AND article.status='published'" : ''})
      RETURNING *`, [...values, Date.now(), sourceId, monitorDate]);
  }
  listCarryoverAutoJobs(sourceId) {
    return this.all(`SELECT job.* FROM archive_jobs job WHERE job.source_id=? AND job.kind='auto'
      AND job.status NOT IN ('cancelled','completed') AND job.article_key IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM archive_articles article WHERE (article.source_key=job.article_key
        OR article.id=(SELECT article_id FROM archive_article_aliases WHERE alias_key=job.article_key)) AND article.captured_at IS NOT NULL)
      ORDER BY job.created_at,job.id`, [sourceId]);
  }

  async getPublicMedia(articleId, key) {
    const article = await this.getArticle(articleId);
    if (!article || article.status !== 'published') return null;
    return manifestEntries(article.manifest).find((entry) => entry.key === key) || null;
  }

  async importLegacyArticle(data) {
    if (!/^[a-f0-9]{32}$/i.test(data.id || '')) throw fail('Legacy ID must be 32 hexadecimal characters');
    const id = data.id.toLowerCase();
    const key = articleKey(data);
    const now = Date.now();
    const manifest = manifestEntries(data.manifest || []);
    const status = data.success === false ? 'failed' : 'published';
    const firstPublished = sourceTimestamp(data);
    const occupied = await this.getArticle(id);
    if (occupied && occupied.source_key !== key) throw fail('Legacy ID conflicts with a different article', 409);
    await this.db.batch([
      this.statement(`INSERT OR IGNORE INTO archive_articles
        (id,source_key,source_id,url,title,account_name,publish_time,first_published_at,status,body_key,manifest_json,metadata_json,
          content_text,summary,captured_at,published_at,legacy_fallback,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [id, key, data.source_id || null, required(data.url, 'url'), data.title || '', data.account_name || '',
        data.publish_time || '', firstPublished, status, data.body_key || null, encode(manifest),
        encode({ ...articleMetadata(data), filename: data.filename || `${id}.html`, source_name: data.source_name || '', source_host: data.source_host || '' }),
        data.content_text || '', data.summary || '', status === 'published' ? now : null,
        status === 'published' ? now : null, now, now]),
      this.statement(`INSERT OR IGNORE INTO archive_article_aliases(alias_key,alias_id,article_id,url)
        SELECT ?,?,id,? FROM archive_articles WHERE source_key=?`, [`legacy-id:${id}`, id, data.url, key]),
      this.statement(`INSERT OR IGNORE INTO archive_article_aliases(alias_key,article_id,url)
        SELECT ?,id,? FROM archive_articles WHERE source_key=?`, [sourceArticleKey(data.url), data.url, key]),
    ]);
    const article = await this.getArticleByKey(key);
    if (!article) throw fail('Legacy ID conflicts with a different article', 409);
    return article;
  }
}
