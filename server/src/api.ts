// The signed-in app's routes: monitors, projects, incidents, webhooks, account and users.

import { Hono } from "hono";
import { all, batch, first, run } from "./db.ts";
import { config } from "./config.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { HttpError, bad, body, id, int, rateLimit, str } from "./http.ts";
import { requireAdmin, requireCollaborator, requireUser, signOutEverywhere, type AppEnv } from "./auth.ts";
import { checkNow, parseHostPort, type Monitor, type MonitorType } from "./checks.ts";
import { EVENTS, WEBHOOK_KINDS, notify, send, testChange, type Webhook } from "./notify.ts";
import { daysByMonitor, monitorView, uptime } from "./views.ts";
import { updateStatus } from "./updates.ts";
import { listPages, pageRoutes, pagesByMonitor } from "./pages.ts";
import { isRole, meView, type User } from "./users.ts";

export const api = new Hono<AppEnv>();
api.use("*", requireUser);

const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
const DAY = 24 * 60 * 60_000;

api.get("/server", (c) => {
  const cfg = config();
  return c.json({
    version: cfg.appVersion,
    publicUrl: cfg.publicUrl,
    retentionDays: cfg.retentionDays,
    oidc: cfg.oidc ? { name: cfg.oidc.name, adminGroups: cfg.oidc.adminGroups.length > 0 } : null,
  });
});

api.get("/updates", async (c) => c.json(await updateStatus(c.req.query("refresh") === "1")));

// --- Projects ---

interface Project {
  id: number;
  name: string;
  color: string;
  position: number;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

api.get("/projects", async (c) => c.json(await all<Project>("SELECT id, name, color, position FROM projects ORDER BY position, lower(name)")));

api.post("/projects", requireCollaborator, async (c) => {
  const b = await body(c);
  const name = str(b.name, 80);
  if (!name) throw bad("A project needs a name");
  const color = COLOR.test(str(b.color)) ? str(b.color) : "#2383e2";
  const { id } = await run("INSERT INTO projects (name, color, position, created_at) VALUES (?, ?, (SELECT coalesce(max(position), 0) + 1 FROM projects), ?)", name, color, Date.now());
  return c.json(await first<Project>("SELECT id, name, color, position FROM projects WHERE id = ?", id), 201);
});

api.patch("/projects/:id", requireCollaborator, async (c) => {
  const pid = id(c);
  const b = await body(c);
  const p = await first<Project>("SELECT * FROM projects WHERE id = ?", pid);
  if (!p) throw new HttpError(404, "Not found");
  const name = b.name !== undefined ? str(b.name, 80) : p.name;
  if (!name) throw bad("A project needs a name");
  const color = b.color !== undefined && COLOR.test(str(b.color)) ? str(b.color) : p.color;
  await run("UPDATE projects SET name = ?, color = ? WHERE id = ?", name, color, pid);
  return c.json({ ...p, name, color });
});

/** The project goes; its monitors stay, without a project. */
api.delete("/projects/:id", requireCollaborator, async (c) => {
  await run("DELETE FROM projects WHERE id = ?", id(c));
  return c.body(null, 204);
});

// --- Status pages ---

api.route("/pages", pageRoutes);

// --- Monitors ---

const TYPES: MonitorType[] = ["http", "tcp", "heartbeat"];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const EXPECTED = /^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/;

const getMonitor = async (mid: number) => {
  const m = await first<Monitor>("SELECT * FROM monitors WHERE id = ?", mid);
  if (!m) throw new HttpError(404, "Not found");
  return m;
};

const canEdit = (u: User) => u.role !== "viewer";

/** Validates a monitor from the form; `old` when editing. */
async function parseMonitor(b: Record<string, unknown>, old?: Monitor) {
  const pick = <K extends keyof Monitor>(k: K) => (b[k] !== undefined ? b[k] : old?.[k]);
  const name = str(pick("name"), 100);
  if (!name) throw bad("A monitor needs a name");
  const type = pick("type") as MonitorType;
  if (!TYPES.includes(type)) throw bad("Unknown monitor type");

  let target = str(pick("target"), 2000);
  if (type === "http") {
    try {
      const u = new URL(target);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
      target = u.toString();
    } catch {
      throw bad("Enter a URL starting with http:// or https://");
    }
  } else if (type === "tcp") {
    if (!parseHostPort(target)) throw bad("Enter host:port, like example.com:22");
  } else target = "";

  const method = str(pick("method"), 10).toUpperCase() || "GET";
  if (!METHODS.includes(method)) throw bad("Unknown HTTP method");
  const expectedStatus = str(pick("expectedStatus"), 100) || "200-299";
  if (!EXPECTED.test(expectedStatus)) throw bad("Expected status codes look like 200-299 or 200,301");

  let projectId = pick("projectId") as number | null | undefined;
  projectId = typeof projectId === "number" ? projectId : null;
  if (projectId !== null && !(await first("SELECT 1 AS x FROM projects WHERE id = ?", projectId))) throw bad("Unknown project");

  return {
    name,
    type,
    target,
    projectId,
    method,
    expectedStatus: expectedStatus.replace(/\s+/g, ""),
    keyword: str(pick("keyword"), 200),
    headers: str(pick("headers"), 4000),
    followRedirects: pick("followRedirects") === undefined ? true : !!pick("followRedirects"),
    timeoutMs: int(pick("timeoutMs"), 1000, 30_000, 10_000),
    intervalS: int(pick("intervalS"), 60, type === "heartbeat" ? 7 * 86400 : 86400, 60),
    retries: int(pick("retries"), 1, 10, 2),
    degradedMs: int(pick("degradedMs"), 0, 60_000, 0),
  };
}

api.get("/monitors", async (c) => {
  const monitors = await all<Monitor>("SELECT * FROM monitors ORDER BY lower(name)");
  const days = await daysByMonitor(monitors.map((m) => m.id));
  const pages = await pagesByMonitor();
  const secrets = canEdit(c.get("user"));
  return c.json(monitors.map((m) => monitorView(m, days.get(m.id) ?? [], { secrets, pages: pages.get(m.id) })));
});

api.get("/monitors/:id", async (c) => {
  const m = await getMonitor(id(c));
  const days = (await daysByMonitor([m.id])).get(m.id) ?? [];
  const since = Date.now() - DAY;
  const day = await first<{ total: number; ok: number; avg: number | null; min: number | null; max: number | null }>(
    "SELECT count(*) AS total, sum(status <> 'down') AS ok, avg(latency) AS avg, min(latency) AS min, max(latency) AS max FROM checks WHERE monitor_id = ? AND at >= ?",
    m.id,
    since,
  );
  const lastDays = (n: number) => days.filter((d) => d.day >= new Date(Date.now() - (n - 1) * DAY).toISOString().slice(0, 10));
  const latency30 = lastDays(30).reduce((a, d) => ({ sum: a.sum + d.latencySum, n: a.n + d.latencyCount }), { sum: 0, n: 0 });
  const open = await first<{ id: number; startedAt: number; cause: string }>("SELECT id, started_at, cause FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL", m.id);
  return c.json({
    ...monitorView(m, days, { secrets: canEdit(c.get("user")), pages: (await pagesByMonitor()).get(m.id) }),
    stats: {
      uptime24h: day?.total ? (day.ok ?? 0) / day.total : null,
      uptime7d: uptime(lastDays(7)),
      uptime30d: uptime(lastDays(30)),
      uptime90d: uptime(days),
      checks24h: day?.total ?? 0,
      avgLatency24h: day?.avg !== null && day?.avg !== undefined ? Math.round(day.avg) : null,
      minLatency24h: day?.min ?? null,
      maxLatency24h: day?.max ?? null,
      avgLatency30d: latency30.n ? Math.round(latency30.sum / latency30.n) : null,
    },
    openIncident: open ? { id: open.id, startedAt: iso(open.startedAt), cause: open.cause } : null,
  });
});

const RANGES: Record<string, { span: number; bucket: number }> = {
  "24h": { span: DAY, bucket: 5 * 60_000 },
  "7d": { span: 7 * DAY, bucket: 60 * 60_000 },
  "30d": { span: 30 * DAY, bucket: 4 * 60 * 60_000 },
};

/** Response times over a range, in buckets: the chart on a monitor's page. */
api.get("/monitors/:id/series", async (c) => {
  const mid = id(c);
  const range = RANGES[c.req.query("range") ?? "24h"] ?? RANGES["24h"];
  const since = Math.floor((Date.now() - range.span) / range.bucket) * range.bucket;
  const rows = await all<{ t: number; avg: number | null; max: number | null; n: number; down: number; degraded: number }>(
    // The bucket size is inlined (it comes from RANGES): D1 binds numbers as floats, and the
    // division must be an integer one.
    `SELECT (at / ${range.bucket}) * ${range.bucket} AS t, avg(latency) AS avg, max(latency) AS max, count(*) AS n, sum(status = 'down') AS down, sum(status = 'degraded') AS degraded
     FROM checks WHERE monitor_id = ? AND at >= ? GROUP BY at / ${range.bucket} ORDER BY t`,
    mid,
    since,
  );
  return c.json({
    from: new Date(since).toISOString(),
    to: new Date().toISOString(),
    bucketMs: range.bucket,
    points: rows.map((r) => ({ t: new Date(r.t).toISOString(), avg: r.avg === null ? null : Math.round(r.avg), max: r.max, n: r.n, down: r.down, degraded: r.degraded })),
  });
});

api.get("/monitors/:id/checks", async (c) => {
  const mid = id(c);
  const limit = int(c.req.query("limit"), 1, 200, 50);
  const failures = c.req.query("failures") === "1";
  const rows = await all<{ at: number; status: string; latency: number | null; code: number | null; message: string }>(
    `SELECT at, status, latency, code, message FROM checks WHERE monitor_id = ? ${failures ? "AND status <> 'up'" : ""} ORDER BY at DESC LIMIT ?`,
    mid,
    limit,
  );
  return c.json(rows.map((r) => ({ ...r, at: iso(r.at) })));
});

api.post("/monitors", requireCollaborator, async (c) => {
  const v = await parseMonitor(await body(c));
  const now = Date.now();
  const { id: mid } = await run(
    `INSERT INTO monitors (project_id, name, type, target, method, expected_status, keyword, headers, follow_redirects, timeout_ms, interval_s, retries, degraded_ms, push_token, next_check_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v.projectId,
    v.name,
    v.type,
    v.target,
    v.method,
    v.expectedStatus,
    v.keyword,
    v.headers,
    v.followRedirects,
    v.timeoutMs,
    v.intervalS,
    v.retries,
    v.degradedMs,
    v.type === "heartbeat" ? randomToken(18) : null,
    // Heartbeats wait for their first ping; the others are checked straight away.
    v.type === "heartbeat" ? now + v.intervalS * 1000 : 0,
    now,
    now,
  );
  const m = await getMonitor(mid);
  if (m.type !== "heartbeat") c.executionCtx.waitUntil(checkNow(m).then((ch) => ch && notify([ch])).catch((e) => console.error(e)));
  return c.json(monitorView(m, [], { secrets: true }), 201);
});

api.patch("/monitors/:id", requireCollaborator, async (c) => {
  const old = await getMonitor(id(c));
  const v = await parseMonitor(await body(c), old);
  // Pointing it somewhere else starts over: the old state says nothing about the new target.
  const retarget = v.type !== old.type || v.target !== old.target;
  const pushToken = v.type === "heartbeat" ? (old.pushToken ?? randomToken(18)) : null;
  await run(
    `UPDATE monitors SET project_id = ?, name = ?, type = ?, target = ?, method = ?, expected_status = ?, keyword = ?, headers = ?, follow_redirects = ?,
       timeout_ms = ?, interval_s = ?, retries = ?, degraded_ms = ?, push_token = ?, updated_at = ?,
       status = CASE WHEN ? THEN 'pending' ELSE status END, fail_count = CASE WHEN ? THEN 0 ELSE fail_count END,
       next_check_at = CASE WHEN ? THEN 0 ELSE min(next_check_at, ?) END
     WHERE id = ?`,
    v.projectId,
    v.name,
    v.type,
    v.target,
    v.method,
    v.expectedStatus,
    v.keyword,
    v.headers,
    v.followRedirects,
    v.timeoutMs,
    v.intervalS,
    v.retries,
    v.degradedMs,
    pushToken,
    Date.now(),
    retarget,
    retarget,
    retarget && v.type !== "heartbeat",
    Date.now() + v.intervalS * 1000,
    old.id,
  );
  if (retarget) await run("UPDATE incidents SET resolved_at = ? WHERE monitor_id = ? AND resolved_at IS NULL", Date.now(), old.id);
  const m = await getMonitor(old.id);
  return c.json(monitorView(m, (await daysByMonitor([m.id])).get(m.id) ?? [], { secrets: true }));
});

api.post("/monitors/:id/pause", requireCollaborator, async (c) => {
  const m = await getMonitor(id(c));
  const paused = !!(await body(c)).paused;
  // Resuming starts fresh: whatever happened while paused wasn't watched.
  await run(
    "UPDATE monitors SET paused = ?, status = CASE WHEN ? THEN status ELSE 'pending' END, fail_count = 0, next_check_at = ?, status_since = ?, updated_at = ? WHERE id = ?",
    paused,
    paused,
    paused ? m.nextCheckAt : 0,
    Date.now(),
    Date.now(),
    m.id,
  );
  if (paused) await run("UPDATE incidents SET resolved_at = ? WHERE monitor_id = ? AND resolved_at IS NULL", Date.now(), m.id);
  return c.json({ ok: true });
});

/** "Check now". */
api.post("/monitors/:id/check", requireCollaborator, async (c) => {
  rateLimit(c, "check", 30, 60_000);
  const m = await getMonitor(id(c));
  if (m.type === "heartbeat") throw bad("Heartbeats are checked when they ping");
  const change = await checkNow(m);
  if (change) c.executionCtx.waitUntil(notify([change]));
  const fresh = await getMonitor(m.id);
  return c.json({ status: fresh.status, latency: fresh.lastLatency, message: fresh.lastMessage });
});

api.post("/monitors/:id/push-token", requireCollaborator, async (c) => {
  const m = await getMonitor(id(c));
  if (m.type !== "heartbeat") throw bad("Only heartbeats have a push URL");
  const token = randomToken(18);
  await run("UPDATE monitors SET push_token = ? WHERE id = ?", token, m.id);
  return c.json({ pushUrl: `${config().publicUrl}/api/push/${token}` });
});

api.delete("/monitors/:id", requireCollaborator, async (c) => {
  await run("DELETE FROM monitors WHERE id = ?", id(c));
  return c.body(null, 204);
});

// --- Incidents ---

api.get("/incidents", async (c) => {
  const monitor = c.req.query("monitor");
  const limit = int(c.req.query("limit"), 1, 500, 100);
  const rows = await all<{ id: number; monitorId: number; monitorName: string; projectId: number | null; startedAt: number; resolvedAt: number | null; cause: string }>(
    `SELECT i.id, i.monitor_id, m.name AS monitor_name, m.project_id, i.started_at, i.resolved_at, i.cause
     FROM incidents i JOIN monitors m ON m.id = i.monitor_id
     ${monitor ? "WHERE i.monitor_id = ?" : ""}
     ORDER BY (i.resolved_at IS NULL) DESC, i.started_at DESC LIMIT ?`,
    ...(monitor ? [Number(monitor), limit] : [limit]),
  );
  return c.json(rows.map((r) => ({ ...r, startedAt: iso(r.startedAt), resolvedAt: iso(r.resolvedAt) })));
});

// --- Webhooks ---

const webhookView = (w: Webhook) => ({
  id: w.id,
  name: w.name,
  kind: w.kind,
  url: w.url,
  hasSecret: !!w.secret,
  events: w.events.split(",").filter(Boolean),
  projects: w.projects.split(",").filter(Boolean).map(Number),
  enabled: !!w.enabled,
  lastSentAt: iso(w.lastSentAt),
  lastError: w.lastError,
});

function parseWebhook(b: Record<string, unknown>, old?: Webhook) {
  const name = str(b.name ?? old?.name, 80);
  if (!name) throw bad("A webhook needs a name");
  const kind = (b.kind ?? old?.kind) as Webhook["kind"];
  if (!WEBHOOK_KINDS.includes(kind)) throw bad("Unknown webhook kind");
  const url = str(b.url ?? old?.url, 2000);
  try {
    if (new URL(url).protocol !== "https:" && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) throw new Error();
  } catch {
    throw bad("The webhook URL must start with https://");
  }
  const events = Array.isArray(b.events) ? b.events.filter((e): e is string => EVENTS.includes(e)).join(",") : (old?.events ?? "down,up");
  const projects = Array.isArray(b.projects) ? b.projects.filter((p): p is number => Number.isInteger(p)).join(",") : (old?.projects ?? "");
  // An empty secret field keeps the old one; `clearSecret` removes it.
  const secret = b.clearSecret ? "" : str(b.secret, 200) || old?.secret || "";
  const enabled = b.enabled === undefined ? (old ? !!old.enabled : true) : !!b.enabled;
  return { name, kind, url, events, projects, secret, enabled };
}

api.get("/webhooks", async (c) => c.json((await all<Webhook>("SELECT * FROM webhooks ORDER BY lower(name)")).map(webhookView)));

api.post("/webhooks", requireCollaborator, async (c) => {
  const v = parseWebhook(await body(c));
  const { id: wid } = await run(
    "INSERT INTO webhooks (name, kind, url, secret, events, projects, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    v.name,
    v.kind,
    v.url,
    v.secret,
    v.events,
    v.projects,
    v.enabled,
    Date.now(),
  );
  return c.json(webhookView((await first<Webhook>("SELECT * FROM webhooks WHERE id = ?", wid))!), 201);
});

api.patch("/webhooks/:id", requireCollaborator, async (c) => {
  const old = await first<Webhook>("SELECT * FROM webhooks WHERE id = ?", id(c));
  if (!old) throw new HttpError(404, "Not found");
  const v = parseWebhook(await body(c), old);
  await run("UPDATE webhooks SET name = ?, kind = ?, url = ?, secret = ?, events = ?, projects = ?, enabled = ? WHERE id = ?", v.name, v.kind, v.url, v.secret, v.events, v.projects, v.enabled, old.id);
  return c.json(webhookView((await first<Webhook>("SELECT * FROM webhooks WHERE id = ?", old.id))!));
});

api.delete("/webhooks/:id", requireCollaborator, async (c) => {
  await run("DELETE FROM webhooks WHERE id = ?", id(c));
  return c.body(null, 204);
});

/** Sends a made-up outage, to see it arrive. */
api.post("/webhooks/:id/test", requireCollaborator, async (c) => {
  rateLimit(c, "webhook-test", 10, 60_000);
  const w = await first<Webhook>("SELECT * FROM webhooks WHERE id = ?", id(c));
  if (!w) throw new HttpError(404, "Not found");
  const error = await send(w, testChange());
  await run("UPDATE webhooks SET last_sent_at = ?, last_error = ? WHERE id = ?", Date.now(), error ?? "", w.id);
  if (error) throw bad(`The webhook failed: ${error}`);
  return c.json({ ok: true });
});

// --- Account ---

api.patch("/profile", async (c) => {
  const b = await body(c);
  const u = c.get("user");
  const name = b.name !== undefined ? str(b.name, 100) : u.name;
  await run("UPDATE users SET name = ? WHERE id = ?", name, u.id);
  return c.json(meView({ ...u, name }));
});

api.get("/sessions", async (c) => {
  const rows = await all<{ id: string; method: string; userAgent: string; ip: string; createdAt: number; lastSeenAt: number }>(
    "SELECT id, method, user_agent, ip, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC",
    c.get("user").id,
    Date.now(),
  );
  const current = c.get("session").id;
  // The id is the token's hash: hash it again so the page never holds anything usable.
  return c.json(
    await Promise.all(rows.map(async (s) => ({ id: (await sha256(s.id)).slice(0, 24), current: s.id === current, method: s.method, userAgent: s.userAgent, ip: s.ip, createdAt: iso(s.createdAt), lastSeenAt: iso(s.lastSeenAt) }))),
  );
});

api.delete("/sessions/:id", async (c) => {
  const want = c.req.param("id");
  const rows = await all<{ id: string }>("SELECT id FROM sessions WHERE user_id = ?", c.get("user").id);
  for (const s of rows) if ((await sha256(s.id)).slice(0, 24) === want) await run("DELETE FROM sessions WHERE id = ?", s.id);
  return c.body(null, 204);
});

api.post("/sessions/revoke-others", async (c) => {
  await signOutEverywhere(c.get("user").id, c.get("session").id);
  return c.json({ ok: true });
});

/** Every project, monitor and webhook (without secrets), as JSON. */
api.get("/export", async (c) => {
  const projects = await all<Project>("SELECT id, name, color, position FROM projects ORDER BY position");
  const monitors = await all<Monitor>("SELECT * FROM monitors ORDER BY id");
  const webhooks = await all<Webhook>("SELECT * FROM webhooks ORDER BY id");
  c.header("Content-Disposition", `attachment; filename="status-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json({
    exportedAt: new Date().toISOString(),
    projects,
    monitors: monitors.map((m) => ({
      id: m.id,
      projectId: m.projectId,
      name: m.name,
      type: m.type,
      target: m.target,
      method: m.method,
      expectedStatus: m.expectedStatus,
      keyword: m.keyword,
      followRedirects: !!m.followRedirects,
      timeoutMs: m.timeoutMs,
      intervalS: m.intervalS,
      retries: m.retries,
      degradedMs: m.degradedMs,
      paused: !!m.paused,
    })),
    webhooks: webhooks.map((w) => ({ name: w.name, kind: w.kind, events: w.events, projects: w.projects, enabled: !!w.enabled })),
    statusPages: await listPages(),
  });
});

// --- Users (admins) ---

api.get("/users", requireAdmin, async (c) => {
  const users = await all<User>("SELECT * FROM users ORDER BY created_at");
  return c.json(users.map((u) => ({ ...meView(u), lastSeenAt: iso(u.lastSeenAt) })));
});

api.patch("/users/:user", requireAdmin, async (c) => {
  const target = c.req.param("user") ?? "";
  const role = (await body(c)).role;
  if (!isRole(role)) throw bad("Unknown role");
  if (target === c.get("user").id && role !== "admin") throw bad("You can't remove your own admin rights");
  if (config().oidc?.adminGroups.length && role === "admin") throw bad("Admins come from the identity provider's groups");
  const { changes } = await run("UPDATE users SET role = ? WHERE id = ?", role, target);
  if (!changes) throw new HttpError(404, "Not found");
  return c.json({ ok: true });
});

api.delete("/users/:user", requireAdmin, async (c) => {
  const target = c.req.param("user") ?? "";
  if (target === c.get("user").id) throw bad("You can't delete yourself here");
  await batch([["DELETE FROM users WHERE id = ?", target]]);
  return c.body(null, 204);
});
