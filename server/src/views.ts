// What the app (and the public status page) sees of monitors: no secrets, times as ISO strings,
// and the day-by-day history for the uptime bars.

import { all } from "./db.ts";
import { config } from "./config.ts";
import type { Monitor } from "./checks.ts";
import type { Expiry } from "./expiry.ts";

export const HISTORY_DAYS = 90;

/** One UTC day of checks. */
export interface Day {
  day: string;
  total: number;
  up: number;
  degraded: number;
  down: number;
  latencySum: number;
  latencyCount: number;
  monitorId: number;
}

const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The days of every monitor in `ids` since `days` ago, grouped by monitor. */
export async function daysByMonitor(ids: number[], days = HISTORY_DAYS): Promise<Map<number, Day[]>> {
  const out = new Map<number, Day[]>();
  if (!ids.length) return out;
  const since = dayKey(Date.now() - (days - 1) * 24 * 60 * 60_000);
  // D1 caps bound parameters at 100 per statement.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await all<Day>(`SELECT * FROM daily WHERE day >= ? AND monitor_id IN (${chunk.map(() => "?").join(",")}) ORDER BY day`, since, ...chunk);
    for (const r of rows) {
      const list = out.get(r.monitorId) ?? [];
      list.push(r);
      out.set(r.monitorId, list);
    }
  }
  return out;
}

/** Up (or degraded, which still answers) over all checks, or null without any. */
export function uptime(days: Pick<Day, "total" | "up" | "degraded">[]): number | null {
  const total = days.reduce((s, d) => s + d.total, 0);
  return total ? days.reduce((s, d) => s + d.up + d.degraded, 0) / total : null;
}

/** [day, checks, down, degraded] for each day with checks: the bars, compactly. */
const history = (days: Day[]) => days.map((d) => [d.day, d.total, d.down, d.degraded] as const);

export const expiryView = (e: Expiry) => ({
  kind: e.kind,
  name: e.name,
  expiresAt: iso(e.expiresAt),
  issuedAt: iso(e.issuedAt),
  issuer: e.issuer,
  source: e.source,
  error: e.error,
  checkedAt: iso(e.checkedAt),
});

export function monitorView(
  m: Monitor,
  days: Day[],
  opts: { secrets: boolean; pages?: { id: number; slug: string; title: string }[]; expiries?: Expiry[]; maintenance?: boolean },
) {
  return {
    id: m.id,
    projectId: m.projectId,
    name: m.name,
    type: m.type,
    target: m.target,
    method: m.method,
    expectedStatus: m.expectedStatus,
    keyword: m.keyword,
    headers: opts.secrets ? m.headers : "",
    followRedirects: !!m.followRedirects,
    timeoutMs: m.timeoutMs,
    intervalS: m.intervalS,
    retries: m.retries,
    degradedMs: m.degradedMs,
    pushUrl: opts.secrets && m.pushToken ? `${config().publicUrl}/api/push/${m.pushToken}` : null,
    lastPingAt: iso(m.lastPingAt),
    // The status pages that show it.
    pages: opts.pages ?? [],
    certCheck: !!m.certCheck,
    domainCheck: !!m.domainCheck,
    domainName: m.domainName,
    expiryWarnDays: m.expiryWarnDays,
    expiries: (opts.expiries ?? []).map(expiryView),
    jsonPath: m.jsonPath,
    jsonOp: m.jsonOp,
    jsonValue: m.jsonValue,
    jsonMissing: m.jsonMissing,
    paused: !!m.paused,
    // Paused wins; then a running maintenance window.
    status: m.paused ? ("paused" as const) : opts.maintenance ? ("maintenance" as const) : m.status,
    lastCheckedAt: iso(m.lastCheckedAt),
    lastLatency: m.lastLatency,
    lastMessage: m.lastMessage,
    statusSince: iso(m.statusSince),
    createdAt: iso(m.createdAt),
    uptime30: uptime(days.filter((d) => d.day >= dayKey(Date.now() - 29 * 24 * 60 * 60_000))),
    uptime90: uptime(days),
    history: history(days),
  };
}

/** The public page's view: what a visitor may know. */
export function publicMonitorView(m: Monitor, days: Day[]) {
  return {
    id: m.id,
    name: m.name,
    status: m.paused ? ("paused" as const) : m.status,
    statusSince: iso(m.statusSince),
    uptime90: uptime(days),
    history: history(days),
  };
}

const DAY_MS = 24 * 60 * 60_000;
export const RANGES: Record<string, { span: number; bucket: number }> = {
  "24h": { span: DAY_MS, bucket: 5 * 60_000 },
  "7d": { span: 7 * DAY_MS, bucket: 60 * 60_000 },
  "30d": { span: 30 * DAY_MS, bucket: 4 * 60 * 60_000 },
};

/** Response times over a range, in buckets (min, mean and max of each): the charts. */
export async function latencySeries(monitorId: number, rangeKey: string | undefined) {
  const range = RANGES[rangeKey ?? "24h"] ?? RANGES["24h"];
  const since = Math.floor((Date.now() - range.span) / range.bucket) * range.bucket;
  const rows = await all<{ t: number; avg: number | null; min: number | null; max: number | null; n: number; down: number; degraded: number }>(
    // The bucket size is inlined (it comes from RANGES): D1 binds numbers as floats, and the
    // division must be an integer one.
    `SELECT (at / ${range.bucket}) * ${range.bucket} AS t, avg(latency) AS avg, min(latency) AS min, max(latency) AS max, count(*) AS n,
       sum(status = 'down') AS down, sum(status = 'degraded') AS degraded
     FROM checks WHERE monitor_id = ? AND at >= ? GROUP BY at / ${range.bucket} ORDER BY t`,
    monitorId,
    since,
  );
  return {
    from: new Date(since).toISOString(),
    to: new Date().toISOString(),
    bucketMs: range.bucket,
    points: rows.map((r) => ({ t: new Date(r.t).toISOString(), avg: r.avg === null ? null : Math.round(r.avg), min: r.min, max: r.max, n: r.n, down: r.down, degraded: r.degraded })),
  };
}
