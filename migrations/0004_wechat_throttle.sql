CREATE TABLE IF NOT EXISTS archive_wechat_throttle (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_allowed_at INTEGER NOT NULL CHECK (next_allowed_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);
INSERT OR IGNORE INTO archive_wechat_throttle(singleton,next_allowed_at,updated_at) VALUES(1,0,0);
