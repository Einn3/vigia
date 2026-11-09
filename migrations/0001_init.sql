CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  check_interval_s INTEGER NOT NULL DEFAULT 60,
  keyword TEXT,                 -- texto que debe aparecer en el body (opcional)
  expected_status INTEGER NOT NULL DEFAULT 200,
  created_at INTEGER NOT NULL
);

CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id),
  ts INTEGER NOT NULL,
  region TEXT NOT NULL,         -- colo que hizo el check ("edge" en la v1)
  ok INTEGER NOT NULL,          -- 1 = bien, 0 = fallo
  status_code INTEGER,
  ttfb_ms INTEGER,
  total_ms INTEGER,
  error TEXT,
  dns_ok INTEGER,
  tls_days_left INTEGER
);
CREATE INDEX idx_checks_monitor_ts ON checks(monitor_id, ts);

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  cause TEXT,                   -- 'http_500' | 'timeout' | 'dns' | 'tls' | ...
  checks_failed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE certs (
  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id),
  issuer TEXT,
  not_after INTEGER,            -- expiración (epoch ms)
  checked_at INTEGER NOT NULL
);
