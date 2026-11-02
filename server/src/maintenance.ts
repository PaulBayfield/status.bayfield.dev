// Planned maintenance: a window (start, end) over some monitors. While it runs those monitors
// aren't checked, so nothing alerts and their uptime isn't counted; status pages showing them
// announce it ahead of time and while it lasts.

import { Hono } from "hono";
import { all, batch, first, run, type Param } from "./db.ts";
import { HttpError, bad, body, id, str } from "./http.ts";
import { requireCollaborator, type AppEnv } from "./auth.ts";

interface Row {
  id: number;
  title: string;
  description: string;
  startsAt: number;
  endsAt: number;
  author: string;
  createdAt: number;
}

const iso = (t: number) => new Date(t).toISOString();
const MAX_WINDOW = 31 * 24 * 60 * 60_000;

/** The monitors in a maintenance window right now. */
export async function inMaintenance(now = Date.now()): Promise<Set<number>> {
  const rows = await all<{ monitorId: number }>(
    "SELECT DISTINCT mm.monitor_id FROM maintenance_monitors mm JOIN maintenances w ON w.id = mm.maintenance_id WHERE w.starts_at <= ? AND w.ends_at > ?",
    now,
    now,
  );
  return new Set(rows.map((r) => r.monitorId));
}

export const IN_MAINTENANCE_SQL =
  "SELECT mm.monitor_id FROM maintenance_monitors mm JOIN maintenances w ON w.id = mm.maintenance_id WHERE w.starts_at <= ? AND w.ends_at > ?";

async function monitorsOf(ids: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (!ids.length) return out;
  const rows = await all<{ maintenanceId: number; monitorId: number }>(
    `SELECT maintenance_id, monitor_id FROM maintenance_monitors WHERE maintenance_id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  for (const r of rows) out.set(r.maintenanceId, [...(out.get(r.maintenanceId) ?? []), r.monitorId]);
  return out;
}

const view = (w: Row, monitors: number[]) => ({
  id: w.id,
  title: w.title,
  description: w.description,
  startsAt: iso(w.startsAt),
  endsAt: iso(w.endsAt),
  author: w.author,
  monitors,
});

/** For a status page: windows over these monitors that are running or start within 30 days. */
export async function maintenancesFor(monitorIds: number[], now = Date.now()) {
  if (!monitorIds.length) return [];
  const rows = await all<Row & { monitorId: number }>(
    `SELECT w.*, mm.monitor_id FROM maintenances w JOIN maintenance_monitors mm ON mm.maintenance_id = w.id
     WHERE w.ends_at > ? AND w.starts_at < ? AND mm.monitor_id IN (${monitorIds.map(() => "?").join(",")}) ORDER BY w.starts_at`,
    now,
    now + 30 * 24 * 60 * 60_000,
    ...monitorIds,
  );
  const byId = new Map<number, { row: Row; monitors: number[] }>();
  for (const { monitorId, ...row } of rows) {
    const e = byId.get(row.id) ?? { row, monitors: [] };
    e.monitors.push(monitorId);
    byId.set(row.id, e);
  }
  return [...byId.values()].map(({ row, monitors }) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    active: row.startsAt <= now,
    monitors,
  }));
}

// --- The app's routes ---

export const maintenanceRoutes = new Hono<AppEnv>();

async function parse(b: Record<string, unknown>, old?: Row) {
  const title = b.title !== undefined ? str(b.title, 150) : (old?.title ?? "");
  if (!title) throw bad("A maintenance needs a title");
  const time = (v: unknown, fallback?: number) => {
    if (v === undefined && fallback !== undefined) return fallback;
    const t = typeof v === "string" || typeof v === "number" ? new Date(v).getTime() : NaN;
    if (!Number.isFinite(t)) throw bad("Pick a start and an end");
    return t;
  };
  const startsAt = time(b.startsAt, old?.startsAt);
  const endsAt = time(b.endsAt, old?.endsAt);
  if (endsAt <= startsAt) throw bad("The end must be after the start");
  if (endsAt - startsAt > MAX_WINDOW) throw bad("A maintenance lasts 31 days at most");
  let monitors: number[] | undefined;
  if (b.monitors !== undefined) {
    if (!Array.isArray(b.monitors)) throw bad("Monitors must be a list");
    const known = new Set((await all<{ id: number }>("SELECT id FROM monitors")).map((m) => m.id));
    monitors = [...new Set(b.monitors.filter((x): x is number => typeof x === "number" && known.has(x)))];
    if (!monitors.length) throw bad("Pick the monitors it concerns");
  }
  return { title, description: b.description !== undefined ? str(b.description, 4000) : (old?.description ?? ""), startsAt, endsAt, monitors };
}

const links = (wid: number, monitors: number[]): [string, ...Param[]][] => [
  ["DELETE FROM maintenance_monitors WHERE maintenance_id = ?", wid],
  ...monitors.map((m): [string, ...Param[]] => ["INSERT INTO maintenance_monitors (maintenance_id, monitor_id) VALUES (?, ?)", wid, m]),
];

maintenanceRoutes.get("/", async (c) => {
  // Everything current or to come, and the last 90 days.
  const rows = await all<Row>("SELECT * FROM maintenances WHERE ends_at > ? ORDER BY starts_at DESC", Date.now() - 90 * 24 * 60 * 60_000);
  const mons = await monitorsOf(rows.map((r) => r.id));
  return c.json(rows.map((r) => view(r, mons.get(r.id) ?? [])));
});

maintenanceRoutes.post("/", requireCollaborator, async (c) => {
  const v = await parse(await body(c));
  if (!v.monitors) throw bad("Pick the monitors it concerns");
  const { id: wid } = await run(
    "INSERT INTO maintenances (title, description, starts_at, ends_at, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    v.title,
    v.description,
    v.startsAt,
    v.endsAt,
    c.get("user").name,
    Date.now(),
  );
  await batch(links(wid, v.monitors));
  return c.json(view((await first<Row>("SELECT * FROM maintenances WHERE id = ?", wid))!, v.monitors), 201);
});

maintenanceRoutes.patch("/:id", requireCollaborator, async (c) => {
  const old = await first<Row>("SELECT * FROM maintenances WHERE id = ?", id(c));
  if (!old) throw new HttpError(404, "Not found");
  const v = await parse(await body(c), old);
  await batch([
    ["UPDATE maintenances SET title = ?, description = ?, starts_at = ?, ends_at = ? WHERE id = ?", v.title, v.description, v.startsAt, v.endsAt, old.id],
    ...(v.monitors ? links(old.id, v.monitors) : []),
  ]);
  const mons = await monitorsOf([old.id]);
  return c.json(view((await first<Row>("SELECT * FROM maintenances WHERE id = ?", old.id))!, mons.get(old.id) ?? []));
});

/** "End now": the window closes and the monitors are checked again at once. */
maintenanceRoutes.post("/:id/end", requireCollaborator, async (c) => {
  const w = await first<Row>("SELECT * FROM maintenances WHERE id = ?", id(c));
  if (!w) throw new HttpError(404, "Not found");
  const now = Date.now();
  await batch([
    ["UPDATE maintenances SET ends_at = ?, starts_at = min(starts_at, ?) WHERE id = ?", now, now, w.id],
    ["UPDATE monitors SET next_check_at = 0, fail_count = 0 WHERE id IN (SELECT monitor_id FROM maintenance_monitors WHERE maintenance_id = ?)", w.id],
  ]);
  return c.json({ ok: true });
});

maintenanceRoutes.delete("/:id", requireCollaborator, async (c) => {
  await run("DELETE FROM maintenances WHERE id = ?", id(c));
  return c.body(null, 204);
});
