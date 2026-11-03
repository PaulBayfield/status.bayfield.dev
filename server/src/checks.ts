// Running the checks: probing a monitor, recording the outcome, and turning a change of state into
// an incident and a notification.
//
// Every minute the cron trigger runs the monitors that are due (see index.ts → scheduled).

import { connect } from "cloudflare:sockets";
import { all, batch, first, run } from "./db.ts";
import { config } from "./config.ts";
import { notify, type Change } from "./notify.ts";
import { checkExpiries, dueExpiries, type ExpiryNotice } from "./expiry.ts";
import { IN_MAINTENANCE_SQL, inMaintenance, maintenanceNotices } from "./maintenance.ts";

export type MonitorType = "http" | "tcp" | "heartbeat";
export type Status = "pending" | "up" | "degraded" | "down";
export type Outcome = Exclude<Status, "pending">;

export interface Monitor {
  id: number;
  projectId: number | null;
  name: string;
  type: MonitorType;
  target: string;
  method: string;
  expectedStatus: string;
  keyword: string;
  headers: string;
  followRedirects: number;
  timeoutMs: number;
  intervalS: number;
  retries: number;
  degradedMs: number;
  pushToken: string | null;
  lastPingAt: number | null;
  paused: number;
  status: Status;
  failCount: number;
  lastCheckedAt: number | null;
  nextCheckAt: number;
  lastLatency: number | null;
  lastMessage: string;
  statusSince: number | null;
  createdAt: number;
  updatedAt: number;
  /** HTTP monitors: watch the SSL certificate's and the domain's expiry. */
  certCheck: number;
  domainCheck: number;
  domainName: string;
  expiryWarnDays: number;
}

export interface Result {
  status: Outcome;
  latency: number | null;
  code: number | null;
  message: string;
}

/** Workers keep at most 6 connections open at once; more would queue and skew the timings. */
const CONCURRENCY = 6;
/** A cron run's budget of outgoing requests (50 on the free plan): checks plus webhooks. */
const MAX_CHECKS_PER_RUN = 30;

const USER_AGENT = "Mozilla/5.0 (compatible; status.bayfield.dev uptime monitor)";

// --- Probes ---

/** "200-299,301" → does `code` match? */
export function statusMatches(code: number, expected: string): boolean {
  const parts = expected.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return code >= 200 && code < 400;
  return parts.some((p) => {
    const [a, b] = p.split("-").map((x) => Number(x.trim()));
    return b === undefined ? code === a : code >= a && code <= b;
  });
}

export function parseHeaders(text: string): [string, string][] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l.includes(":"))
    .map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()] as [string, string])
    .filter(([k]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k));
}

const describe = (e: unknown): string => {
  const err = e as Error;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "Timed out";
  return (err?.message || String(e)).slice(0, 300);
};

async function probeHttp(m: Monitor): Promise<Result> {
  const started = Date.now();
  try {
    const headers = new Headers({ "user-agent": USER_AGENT, accept: "*/*" });
    for (const [k, v] of parseHeaders(m.headers)) headers.set(k, v);
    const res = await fetch(m.target, {
      method: m.method,
      headers,
      redirect: m.followRedirects ? "follow" : "manual",
      signal: AbortSignal.timeout(m.timeoutMs),
      cache: "no-store",
    });
    let text = "";
    if (m.keyword) text = await res.text();
    else await res.body?.cancel();
    const latency = Date.now() - started;
    if (!statusMatches(res.status, m.expectedStatus)) {
      return { status: "down", latency, code: res.status, message: `Answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}, expected ${m.expectedStatus}` };
    }
    if (m.keyword) {
      // A leading "!" means the keyword must NOT be there (an error page, say).
      const negate = m.keyword.startsWith("!");
      const word = negate ? m.keyword.slice(1) : m.keyword;
      if (text.includes(word) === negate) {
        return { status: "down", latency, code: res.status, message: negate ? `Found “${word}” in the response` : `“${word}” not found in the response` };
      }
    }
    const slow = m.degradedMs > 0 && latency > m.degradedMs;
    return { status: slow ? "degraded" : "up", latency, code: res.status, message: slow ? `Slow: ${latency} ms (over ${m.degradedMs} ms)` : `${res.status} OK` };
  } catch (e) {
    return { status: "down", latency: null, code: null, message: describe(e) };
  }
}

/** host:port, [v6]:port. */
export function parseHostPort(target: string): { hostname: string; port: number } | null {
  const m = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(target.trim());
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { hostname: m[1], port } : null;
}

async function probeTcp(m: Monitor): Promise<Result> {
  const addr = parseHostPort(m.target);
  if (!addr) return { status: "down", latency: null, code: null, message: "The target isn't host:port" };
  const started = Date.now();
  let socket: Socket | null = null;
  try {
    socket = connect(addr);
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("Timed out"), { name: "TimeoutError" })), m.timeoutMs)),
    ]);
    const latency = Date.now() - started;
    const slow = m.degradedMs > 0 && latency > m.degradedMs;
    return { status: slow ? "degraded" : "up", latency, code: null, message: slow ? `Slow: ${latency} ms (over ${m.degradedMs} ms)` : "Port open" };
  } catch (e) {
    return { status: "down", latency: null, code: null, message: describe(e) };
  } finally {
    socket?.close().catch(() => {});
  }
}

/** A heartbeat is down when nothing called its push URL within the interval (plus a minute's grace). */
function probeHeartbeat(m: Monitor, now: number): Result | null {
  const grace = 60_000;
  const since = m.lastPingAt ?? m.createdAt;
  if (now - since <= m.intervalS * 1000 + grace) return null;
  const ago = Math.round((now - since) / 60_000);
  return { status: "down", latency: null, code: null, message: m.lastPingAt ? `No heartbeat for ${ago} min` : "No heartbeat received yet" };
}

export async function probe(m: Monitor, now = Date.now()): Promise<Result | null> {
  if (m.type === "http") return probeHttp(m);
  if (m.type === "tcp") return probeTcp(m);
  return probeHeartbeat(m, now);
}

// --- Recording ---

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Saves a check and moves the monitor to its new state. A failure only counts as down after
 * `retries` failures in a row, so one lost packet doesn't page anyone.
 * Returns the change of state to notify about, if any.
 */
export async function record(m: Monitor, r: Result, now = Date.now()): Promise<Change | null> {
  const prev = m.status;
  const failCount = r.status === "down" ? m.failCount + 1 : 0;
  const confirmations = m.type === "heartbeat" ? 1 : Math.max(1, m.retries);
  const next: Status = r.status !== "down" ? r.status : failCount >= confirmations ? "down" : prev;
  const changed = next !== prev;

  const statements: [string, ...(string | number | null)[]][] = [
    ["INSERT INTO checks (monitor_id, at, status, latency, code, message) VALUES (?, ?, ?, ?, ?, ?)", m.id, now, r.status, r.latency, r.code, r.message],
    [
      `INSERT INTO daily (monitor_id, day, total, up, degraded, down, latency_sum, latency_count) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT (monitor_id, day) DO UPDATE SET total = total + 1, up = up + excluded.up, degraded = degraded + excluded.degraded,
         down = down + excluded.down, latency_sum = latency_sum + excluded.latency_sum, latency_count = latency_count + excluded.latency_count`,
      m.id,
      day(now),
      r.status === "up" ? 1 : 0,
      r.status === "degraded" ? 1 : 0,
      r.status === "down" ? 1 : 0,
      r.latency ?? 0,
      r.latency === null ? 0 : 1,
    ],
    [
      "UPDATE monitors SET status = ?, fail_count = ?, last_checked_at = ?, next_check_at = ?, last_latency = ?, last_message = ?, status_since = ? WHERE id = ?",
      next,
      failCount,
      now,
      now + m.intervalS * 1000,
      r.latency,
      r.message,
      changed ? now : (m.statusSince ?? now),
      m.id,
    ],
  ];
  if (changed && next === "down") statements.push(["INSERT INTO incidents (monitor_id, started_at, cause) VALUES (?, ?, ?)", m.id, now, r.message]);
  if (changed && prev === "down") statements.push(["UPDATE incidents SET resolved_at = ? WHERE monitor_id = ? AND resolved_at IS NULL", now, m.id]);
  await batch(statements);

  // A new monitor coming up isn't news.
  if (!changed || (prev === "pending" && next === "up")) return null;
  return { monitor: { ...m, status: next }, from: prev, to: next as Outcome, result: r, at: now, downSince: prev === "down" ? m.statusSince : null };
}

/** Probes one monitor now and records it ("Check now", push URLs). */
export async function checkNow(m: Monitor, result?: Result): Promise<Change | null> {
  const r = result ?? (await probe(m));
  if (!r) {
    await run("UPDATE monitors SET next_check_at = ? WHERE id = ?", Date.now() + m.intervalS * 1000, m.id);
    return null;
  }
  return record(m, r);
}

/** Runs `fn` over `items`, at most `n` at a time. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** The cron job: every due monitor, then the notifications, then housekeeping. */
export async function runDue(now = Date.now()) {
  // Monitors in a maintenance window wait: no checks, so no alerts and no downtime counted.
  const due = await all<Monitor>(
    `SELECT * FROM monitors WHERE paused = 0 AND next_check_at <= ? AND id NOT IN (${IN_MAINTENANCE_SQL}) ORDER BY next_check_at LIMIT ?`,
    now + 5_000,
    now,
    now,
    MAX_CHECKS_PER_RUN,
  );
  const changes = await pool(due, CONCURRENCY, async (m) => {
    try {
      // Heartbeats only record when something is wrong; their pings record the rest.
      return await checkNow(m);
    } catch (e) {
      console.error(`Check of monitor ${m.id} failed:`, e);
      return null;
    }
  });
  const real = changes.filter((c): c is Change => !!c);
  // Certificates and domains, a couple of monitors at a time, with the requests left in the budget.
  if (due.length <= MAX_CHECKS_PER_RUN - 10) {
    for (const { monitor, kinds } of await dueExpiries(2, now)) {
      try {
        real.push(...(await checkExpiries(monitor, kinds)).map(expiryChange));
      } catch (e) {
        console.error(`Expiry check of monitor ${monitor.id} failed:`, e);
      }
    }
  }
  const notices = await maintenanceNotices(now).catch((e) => {
    console.error("Maintenance notices failed:", e);
    return [];
  });
  await notify([...real, ...notices]);
  await housekeeping(now);
  return { checked: due.length, changes: real.length };
}

/** An expiry warning, as a notification (the monitor's state doesn't change). */
export function expiryChange(n: ExpiryNotice): Change {
  const status: Outcome = n.monitor.status === "pending" ? "up" : n.monitor.status;
  return {
    monitor: n.monitor,
    from: status,
    to: status,
    result: { status, latency: null, code: null, message: n.expiry.error },
    at: Date.now(),
    downSince: null,
    expiry: n.expiry,
  };
}

/** Old checks, expired sessions: once an hour. */
async function housekeeping(now: number) {
  const d = new Date(now);
  if (d.getUTCMinutes() !== 7) return;
  const cutoff = now - config().retentionDays * 24 * 60 * 60_000;
  const monitors = await all<{ id: number }>("SELECT id FROM monitors");
  await batch([
    // Per monitor, so the delete walks the (monitor_id, at) index instead of the whole table.
    ...monitors.map((m): [string, number, number] => ["DELETE FROM checks WHERE monitor_id = ? AND at < ?", m.id, cutoff]),
    ["DELETE FROM daily WHERE day < ?", day(now - 400 * 24 * 60 * 60_000)],
    ["DELETE FROM sessions WHERE expires_at < ?", now],
    ["DELETE FROM oidc_states WHERE expires_at < ?", now],
  ]);
}

/** A heartbeat ping: records "up" (or what the caller reports), right away. */
export async function ping(token: string, reported: { status?: string; msg?: string; ms?: string }) {
  const m = await first<Monitor>("SELECT * FROM monitors WHERE push_token = ? AND type = 'heartbeat'", token);
  if (!m) return null;
  const now = Date.now();
  await run("UPDATE monitors SET last_ping_at = ? WHERE id = ?", now, m.id);
  if (m.paused || (await inMaintenance(now)).has(m.id)) return m;
  const down = reported.status === "down" || reported.status === "error";
  const latency = reported.ms && /^\d+$/.test(reported.ms) ? Math.min(Number(reported.ms), 3_600_000) : null;
  const message = (reported.msg ?? "").slice(0, 300) || (down ? "Reported down" : "Heartbeat received");
  const change = await record({ ...m, lastPingAt: now }, { status: down ? "down" : "up", latency, code: null, message }, now);
  if (change) await notify([change]);
  return m;
}
