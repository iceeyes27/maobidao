CREATE TABLE IF NOT EXISTS archive_scheduler (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id TEXT,
  last_tick_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO archive_scheduler(singleton,updated_at) VALUES(1,0);
