// Cloudflare D1 (SQLite) and the schema migrations.
//
// Columns are snake_case in the database and camelCase in JS (rows are converted on the way out).
// Times are milliseconds since the epoch (integers); booleans are 0/1.

import { env } from "cloudflare:workers";
import type { Env } from "./config.ts";

export const db = () => (env as unknown as Env).DB;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function toCamel<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const k in row) out[camel(k)] = row[k];
  return out as T;
}

export type Param = string | number | null | boolean;
const bind = (sql: string, params: Param[]) =>
  db()
    .prepare(sql)
    .bind(...params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p)));

/** Every row, camelCased. */
export async function all<T>(sql: string, ...params: Param[]): Promise<T[]> {
  const { results } = await bind(sql, params).all<Record<string, unknown>>();
  return results.map((r) => toCamel<T>(r));
}

/** The first row, camelCased, or undefined. */
export async function first<T>(sql: string, ...params: Param[]): Promise<T | undefined> {
  const row = await bind(sql, params).first<Record<string, unknown>>();
  return row ? toCamel<T>(row) : undefined;
}

/** A write; returns the new row id and how many rows changed. */
export async function run(sql: string, ...params: Param[]): Promise<{ id: number; changes: number }> {
  const { meta } = await bind(sql, params).run();
  return { id: Number(meta.last_row_id), changes: meta.changes };
}

/** Several writes in one transaction. */
export async function batch(statements: [string, ...Param[]][]) {
  if (!statements.length) return;
  await db().batch(statements.map(([sql, ...params]) => bind(sql, params)));
}

const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id text PRIMARY KEY,
    name text NOT NULL DEFAULT '',
    email text UNIQUE,
    oidc_sub text UNIQUE,
    role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'collaborator', 'admin')),
    created_at integer NOT NULL,
    last_seen_at integer
  );

  CREATE TABLE sessions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method text NOT NULL,
    user_agent text NOT NULL DEFAULT '',
    ip text NOT NULL DEFAULT '',
    created_at integer NOT NULL,
    last_seen_at integer NOT NULL,
    expires_at integer NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE oidc_states (
    state text PRIMARY KEY,
    verifier text NOT NULL,
    nonce text NOT NULL,
    expires_at integer NOT NULL
  );

  -- Monitors are grouped by project (a site, an app, a server…).
  CREATE TABLE projects (
    id integer PRIMARY KEY AUTOINCREMENT,
    name text NOT NULL,
    color text NOT NULL DEFAULT '#2383e2',
    position integer NOT NULL DEFAULT 0,
    created_at integer NOT NULL
  );

  CREATE TABLE monitors (
    id integer PRIMARY KEY AUTOINCREMENT,
    project_id integer REFERENCES projects(id) ON DELETE SET NULL,
    name text NOT NULL,
    -- http: a URL answers with an expected status (and keyword); tcp: a port accepts connections;
    -- heartbeat: the monitored thing calls /api/push/<token> at least every interval.
    type text NOT NULL CHECK (type IN ('http', 'tcp', 'heartbeat')),
    target text NOT NULL DEFAULT '',
    method text NOT NULL DEFAULT 'GET',
    expected_status text NOT NULL DEFAULT '200-299',
    keyword text NOT NULL DEFAULT '',
    -- Extra request headers, one "Name: value" per line.
    headers text NOT NULL DEFAULT '',
    follow_redirects integer NOT NULL DEFAULT 1,
    timeout_ms integer NOT NULL DEFAULT 10000,
    interval_s integer NOT NULL DEFAULT 60,
    -- Failed checks in a row before it counts as down (fewer false alarms).
    retries integer NOT NULL DEFAULT 2,
    -- Slower than this (ms): degraded. 0: never.
    degraded_ms integer NOT NULL DEFAULT 0,
    push_token text UNIQUE,
    last_ping_at integer,
    paused integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'up', 'degraded', 'down')),
    fail_count integer NOT NULL DEFAULT 0,
    last_checked_at integer,
    next_check_at integer NOT NULL DEFAULT 0,
    last_latency integer,
    last_message text NOT NULL DEFAULT '',
    status_since integer,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  );
  CREATE INDEX monitors_due ON monitors(next_check_at) WHERE paused = 0;

  -- Every check's outcome, kept for RETENTION_DAYS.
  CREATE TABLE checks (
    monitor_id integer NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    at integer NOT NULL,
    status text NOT NULL,
    latency integer,
    code integer,
    message text NOT NULL DEFAULT ''
  );
  CREATE INDEX checks_monitor_at ON checks(monitor_id, at);

  -- One row per monitor and UTC day, counted as checks come in: the 90-day uptime bars.
  CREATE TABLE daily (
    monitor_id integer NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    day text NOT NULL,
    total integer NOT NULL,
    up integer NOT NULL,
    degraded integer NOT NULL,
    down integer NOT NULL,
    latency_sum integer NOT NULL,
    latency_count integer NOT NULL,
    PRIMARY KEY (monitor_id, day)
  );

  -- Down periods, opened when a monitor goes down and closed when it's back.
  CREATE TABLE incidents (
    id integer PRIMARY KEY AUTOINCREMENT,
    monitor_id integer NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    started_at integer NOT NULL,
    resolved_at integer,
    cause text NOT NULL DEFAULT ''
  );
  CREATE INDEX incidents_monitor ON incidents(monitor_id, started_at);
  CREATE INDEX incidents_started ON incidents(started_at);

  -- Where to send notifications when a monitor changes state.
  CREATE TABLE webhooks (
    id integer PRIMARY KEY AUTOINCREMENT,
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('discord', 'slack', 'ntfy', 'generic')),
    url text NOT NULL,
    -- generic: requests are signed with HMAC-SHA256 of the body (X-Status-Signature).
    secret text NOT NULL DEFAULT '',
    -- Comma-separated: down, up, degraded.
    events text NOT NULL DEFAULT 'down,up',
    -- Comma-separated project ids; empty: every monitor.
    projects text NOT NULL DEFAULT '',
    enabled integer NOT NULL DEFAULT 1,
    last_sent_at integer,
    last_error text NOT NULL DEFAULT '',
    created_at integer NOT NULL
  );

  -- Public status pages, like Uptime Kuma's: each at /status/<slug>, showing groups of monitors.
  -- The default page is also /status, and / for visitors who aren't signed in.
  CREATE TABLE status_pages (
    id integer PRIMARY KEY AUTOINCREMENT,
    slug text NOT NULL UNIQUE,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    is_default integer NOT NULL DEFAULT 0,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  );

  CREATE TABLE status_page_groups (
    id integer PRIMARY KEY AUTOINCREMENT,
    page_id integer NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
    -- Empty: no heading.
    name text NOT NULL DEFAULT '',
    position integer NOT NULL,
    UNIQUE (page_id, position)
  );

  CREATE TABLE status_page_monitors (
    group_id integer NOT NULL REFERENCES status_page_groups(id) ON DELETE CASCADE,
    monitor_id integer NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    position integer NOT NULL,
    PRIMARY KEY (group_id, monitor_id)
  );
  CREATE INDEX status_page_monitors_monitor ON status_page_monitors(monitor_id);

  CREATE TABLE kv (key text PRIMARY KEY, value text NOT NULL);
  `,
  /* 2: a status page's logo, as a link to an image hosted elsewhere */ `
  ALTER TABLE status_pages ADD COLUMN logo_url text NOT NULL DEFAULT '';
  `,
  /* 3: what each webhook's messages say and look like (JSON, empty: the defaults) */ `
  ALTER TABLE webhooks ADD COLUMN template text NOT NULL DEFAULT '';
  `,
  /* 4: SSL certificate and domain expiry for HTTP monitors; what status pages show */ `
  ALTER TABLE monitors ADD COLUMN cert_check integer NOT NULL DEFAULT 0;
  ALTER TABLE monitors ADD COLUMN domain_check integer NOT NULL DEFAULT 0;
  -- Empty: the registered domain of the target's host.
  ALTER TABLE monitors ADD COLUMN domain_name text NOT NULL DEFAULT '';
  ALTER TABLE monitors ADD COLUMN expiry_warn_days integer NOT NULL DEFAULT 14;
  CREATE TABLE expiries (
    monitor_id integer NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('certificate', 'domain')),
    name text NOT NULL DEFAULT '',
    expires_at integer,
    issued_at integer,
    issuer text NOT NULL DEFAULT '',
    source text NOT NULL DEFAULT '',
    error text NOT NULL DEFAULT '',
    checked_at integer NOT NULL,
    -- The last warning sent: warn, urgent, expired.
    stage text NOT NULL DEFAULT '',
    PRIMARY KEY (monitor_id, kind)
  );
  -- JSON: uptime bars, tiles, incidents, response time charts. Empty: the defaults.
  ALTER TABLE status_pages ADD COLUMN display text NOT NULL DEFAULT '';
  `,
  /* 5: custom domains, incident posts, maintenance windows */ `
  -- A host name (status.example.com) that serves this page at /. Empty: none.
  ALTER TABLE status_pages ADD COLUMN domain text NOT NULL DEFAULT '';
  CREATE UNIQUE INDEX status_pages_domain ON status_pages(domain) WHERE domain <> '';

  -- Incident posts written by a person, shown on chosen status pages with their updates.
  CREATE TABLE posts (
    id integer PRIMARY KEY AUTOINCREMENT,
    title text NOT NULL,
    impact text NOT NULL DEFAULT 'minor' CHECK (impact IN ('none', 'minor', 'major')),
    status text NOT NULL DEFAULT 'investigating' CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
    author text NOT NULL DEFAULT '',
    created_at integer NOT NULL,
    updated_at integer NOT NULL,
    resolved_at integer
  );
  CREATE INDEX posts_created ON posts(created_at);
  CREATE TABLE post_updates (
    id integer PRIMARY KEY AUTOINCREMENT,
    post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
    body text NOT NULL DEFAULT '',
    author text NOT NULL DEFAULT '',
    created_at integer NOT NULL
  );
  CREATE INDEX post_updates_post ON post_updates(post_id, created_at);
  CREATE TABLE post_pages (
    post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    page_id integer NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, page_id)
  );
  -- The monitors it affects (shown as such on the pages).
  CREATE TABLE post_monitors (
    post_id integer NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    monitor_id integer NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, monitor_id)
  );

  -- Planned maintenance: the monitors aren't checked (nor alerted on) during the window, and the
  -- pages that show them announce it.
  CREATE TABLE maintenances (
    id integer PRIMARY KEY AUTOINCREMENT,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    starts_at integer NOT NULL,
    ends_at integer NOT NULL,
    author text NOT NULL DEFAULT '',
    created_at integer NOT NULL
  );
  CREATE INDEX maintenances_window ON maintenances(ends_at, starts_at);
  CREATE TABLE maintenance_monitors (
    maintenance_id integer NOT NULL REFERENCES maintenances(id) ON DELETE CASCADE,
    monitor_id integer NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    PRIMARY KEY (maintenance_id, monitor_id)
  );
  CREATE INDEX maintenance_monitors_monitor ON maintenance_monitors(monitor_id);
  `,
  /* 6: notifications for maintenance windows (scheduled, started, over) */ `
  ALTER TABLE maintenances ADD COLUMN notify integer NOT NULL DEFAULT 1;
  ALTER TABLE maintenances ADD COLUMN start_notified integer NOT NULL DEFAULT 0;
  ALTER TABLE maintenances ADD COLUMN end_notified integer NOT NULL DEFAULT 0;
  -- Windows that already started or ended aren't announced again.
  UPDATE maintenances SET start_notified = 1 WHERE starts_at <= unixepoch() * 1000;
  UPDATE maintenances SET end_notified = 1 WHERE ends_at <= unixepoch() * 1000;
  `,
];

let migrated: Promise<void> | null = null;

/** Brings the schema up to date, once per isolate. Never edit an applied migration: append one. */
export function migrate(): Promise<void> {
  migrated ??= (async () => {
    await db().exec("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at integer NOT NULL)");
    const row = await first<{ v: number }>("SELECT coalesce(max(version), 0) AS v FROM schema_migrations");
    for (let i = row?.v ?? 0; i < MIGRATIONS.length; i++) {
      // One batch is one transaction: if another isolate migrates at the same moment, the version's
      // primary key makes one of them fail and roll back.
      // D1 runs one statement at a time: drop the comments (they may hold a ";"), then split.
      const statements = MIGRATIONS[i]
        .replace(/^\s*--.*$/gm, "")
        .split(/;\s*$/m)
        .map((s) => s.trim())
        .filter(Boolean);
      try {
        await db().batch([...statements.map((s) => db().prepare(s)), db().prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").bind(i + 1, Date.now())]);
        console.log(`Database migrated to version ${i + 1}`);
      } catch (e) {
        const done = await first<{ v: number }>("SELECT coalesce(max(version), 0) AS v FROM schema_migrations");
        if ((done?.v ?? 0) <= i) throw e;
      }
    }
  })().catch((e) => {
    migrated = null;
    throw e;
  });
  return migrated;
}
