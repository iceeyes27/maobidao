PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS archive_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  fakeid TEXT NOT NULL UNIQUE,
  account_biz TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  baseline_completed_at INTEGER,
  activated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_source_baseline (
  source_id TEXT NOT NULL REFERENCES archive_sources(id),
  source_key TEXT NOT NULL,
  PRIMARY KEY (source_id, source_key)
);

CREATE TABLE IF NOT EXISTS archive_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('baseline', 'history', 'manual', 'auto')),
  source_id TEXT REFERENCES archive_sources(id),
  status TEXT NOT NULL DEFAULT 'queued',
  range_start INTEGER,
  range_end INTEGER,
  urls_json TEXT NOT NULL DEFAULT '[]',
  monitor_date TEXT,
  article_key TEXT,
  cursor_json TEXT,
  progress_json TEXT NOT NULL DEFAULT '{}',
  discovered_count INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_retry_at INTEGER,
  workflow_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  request_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_jobs_source_status ON archive_jobs(source_id, kind, status, created_at);

CREATE TABLE IF NOT EXISTS archive_articles (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  source_key TEXT NOT NULL UNIQUE,
  source_id TEXT REFERENCES archive_sources(id),
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  publish_time TEXT NOT NULL DEFAULT '',
  first_published_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  body_key TEXT,
  manifest_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  content_text TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  captured_at INTEGER,
  published_at INTEGER,
  last_error TEXT,
  legacy_fallback INTEGER NOT NULL DEFAULT 0 CHECK (legacy_fallback IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_articles_published ON archive_articles(status, first_published_at DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS archive_article_aliases (
  alias_key TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES archive_articles(id),
  alias_id TEXT UNIQUE,
  url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_job_items (
  job_id TEXT NOT NULL REFERENCES archive_jobs(id),
  article_id TEXT NOT NULL REFERENCES archive_articles(id),
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  attempt_window TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, article_id)
);
CREATE INDEX IF NOT EXISTS archive_job_items_article ON archive_job_items(article_id, job_id);

CREATE TABLE IF NOT EXISTS archive_leases (
  resource TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_daily_runs (
  source_id TEXT NOT NULL REFERENCES archive_sources(id),
  monitor_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'monitoring',
  selected_article_key TEXT,
  job_id TEXT REFERENCES archive_jobs(id),
  capture_completed_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, monitor_date)
);

CREATE TABLE IF NOT EXISTS archive_dispatch_outbox (
  job_id TEXT PRIMARY KEY REFERENCES archive_jobs(id),
  workflow_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL DEFAULT 1,
  dispatched_generation INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT 'start',
  dispatched_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_login (
  id TEXT PRIMARY KEY,
  browser_session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  live_view_url TEXT,
  purpose TEXT NOT NULL DEFAULT 'account',
  target_url TEXT
);

CREATE TABLE IF NOT EXISTS archive_session (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL DEFAULT 0,
  active_login_id TEXT,
  object_key TEXT,
  updated_at INTEGER
);
INSERT OR IGNORE INTO archive_session(singleton, version) VALUES (1, 0);
