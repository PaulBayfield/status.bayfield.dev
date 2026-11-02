-- Demo projects and monitors for local development: npm run seed (after the first request has
-- created the schema, e.g. opening http://localhost:8820/api/health).

INSERT INTO projects (name, color, position, created_at) VALUES
  ('bayfield.dev', '#2383e2', 1, unixepoch() * 1000),
  ('Home server', '#9065b0', 2, unixepoch() * 1000);

INSERT INTO monitors (project_id, name, type, target, interval_s, retries, degraded_ms, next_check_at, created_at, updated_at) VALUES
  (1, 'Website', 'http', 'https://bayfield.dev/', 60, 2, 1500, 0, unixepoch() * 1000, unixepoch() * 1000),
  (1, 'GitHub API', 'http', 'https://api.github.com/', 60, 2, 0, 0, unixepoch() * 1000, unixepoch() * 1000),
  (2, 'SSH', 'tcp', 'github.com:22', 120, 2, 0, 0, unixepoch() * 1000, unixepoch() * 1000),
  (NULL, 'Broken on purpose', 'http', 'https://httpbin.org/status/503', 300, 1, 0, 0, unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO monitors (project_id, name, type, target, interval_s, push_token, next_check_at, created_at, updated_at) VALUES
  (2, 'Nightly backup', 'heartbeat', '', 86400, 'demo-backup-token', unixepoch() * 1000 + 86400000, unixepoch() * 1000, unixepoch() * 1000);

-- Two status pages: the default one (/status) and one for a single project (/status/home).
INSERT INTO status_pages (slug, title, description, is_default, created_at, updated_at) VALUES
  ('bayfield', 'bayfield.dev status', 'Live status of the bayfield.dev websites and apps.', 1, unixepoch() * 1000, unixepoch() * 1000),
  ('home', 'Home server', '', 0, unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO status_page_groups (page_id, name, position) VALUES
  (1, 'Websites', 0),
  (1, 'APIs', 1),
  (2, '', 0);

INSERT INTO status_page_monitors (group_id, monitor_id, position) VALUES
  (1, 1, 0),
  (2, 2, 0),
  (3, 3, 0),
  (3, 5, 1);
