// What the app (and the public status page) sees of monitors: no secrets, times as ISO strings,
// and the day-by-day history for the uptime bars.

import { all } from "./db.ts";
import { config } from "./config.ts";
import type { Monitor } from "./checks.ts";

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

export function monitorView(m: Monitor, days: Day[], opts: { secrets: boolean; pages?: { id: number; slug: string; title: string }[] }) {
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
    paused: !!m.paused,
    status: m.paused ? ("paused" as const) : m.status,
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
