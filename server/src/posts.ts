// Incident posts, written by a person (unlike the automatic incidents): a title, an impact, a
// status (investigating → identified → monitoring → resolved), and a timeline of updates. Each post
// is shown on the status pages it's published to, with the monitors it affects.

import { Hono } from "hono";
import { all, batch, first, run, type Param } from "./db.ts";
import { HttpError, bad, body, id, str } from "./http.ts";
import { requireCollaborator, type AppEnv } from "./auth.ts";
import { forgetPages } from "./public.ts";

export const POST_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
export const IMPACTS = ["none", "minor", "major"] as const;

interface Row {
  id: number;
  title: string;
  impact: (typeof IMPACTS)[number];
  status: PostStatus;
  author: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

interface UpdateRow {
  id: number;
  postId: number;
  status: PostStatus;
  body: string;
  author: string;
  createdAt: number;
}

const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

async function details(ids: number[]) {
  const updates = new Map<number, UpdateRow[]>();
  const pages = new Map<number, number[]>();
  const monitors = new Map<number, number[]>();
  if (!ids.length) return { updates, pages, monitors };
  for (const u of await all<UpdateRow>(`SELECT * FROM post_updates WHERE post_id IN (${marks(ids.length)}) ORDER BY created_at DESC, id DESC`, ...ids)) {
    updates.set(u.postId, [...(updates.get(u.postId) ?? []), u]);
  }
  for (const r of await all<{ postId: number; pageId: number }>(`SELECT post_id, page_id FROM post_pages WHERE post_id IN (${marks(ids.length)})`, ...ids)) {
    pages.set(r.postId, [...(pages.get(r.postId) ?? []), r.pageId]);
  }
  for (const r of await all<{ postId: number; monitorId: number }>(`SELECT post_id, monitor_id FROM post_monitors WHERE post_id IN (${marks(ids.length)})`, ...ids)) {
    monitors.set(r.postId, [...(monitors.get(r.postId) ?? []), r.monitorId]);
  }
  return { updates, pages, monitors };
}

const updateView = (u: UpdateRow, withAuthor: boolean) => ({
  id: u.id,
  status: u.status,
  body: u.body,
  createdAt: iso(u.createdAt),
  ...(withAuthor ? { author: u.author } : {}),
});

/** For a status page: its open posts, and those resolved in the last 14 days. */
export async function postsFor(pageId: number, now = Date.now()) {
  const rows = await all<Row>(
    `SELECT p.* FROM posts p JOIN post_pages pp ON pp.post_id = p.id WHERE pp.page_id = ? AND (p.resolved_at IS NULL OR p.resolved_at > ?) ORDER BY p.created_at DESC LIMIT 20`,
    pageId,
    now - 14 * 24 * 60 * 60_000,
  );
  const d = await details(rows.map((r) => r.id));
  return rows.map((p) => ({
    id: p.id,
    title: p.title,
    impact: p.impact,
    status: p.status,
    createdAt: iso(p.createdAt),
    resolvedAt: iso(p.resolvedAt),
    monitors: d.monitors.get(p.id) ?? [],
    // The visitors' timeline: no author names.
    updates: (d.updates.get(p.id) ?? []).map((u) => updateView(u, false)),
  }));
}

// --- The app's routes ---

export const postRoutes = new Hono<AppEnv>();

async function slugsOf(pageIds: number[]): Promise<string[]> {
  if (!pageIds.length) return [];
  return (await all<{ slug: string }>(`SELECT slug FROM status_pages WHERE id IN (${marks(pageIds.length)})`, ...pageIds)).map((r) => r.slug);
}

/** Visitors see a change at once, not after the page's minute of caching. */
async function refreshPages(c: { req: { url: string }; executionCtx: { waitUntil(p: Promise<unknown>): void } }, pageIds: number[]) {
  const slugs = await slugsOf(pageIds);
  c.executionCtx.waitUntil(forgetPages(new URL(c.req.url).origin, slugs));
}

async function ids(v: unknown, table: "status_pages" | "monitors", what: string): Promise<number[]> {
  if (!Array.isArray(v)) throw bad(`${what} must be a list`);
  const known = new Set((await all<{ id: number }>(`SELECT id FROM ${table}`)).map((r) => r.id));
  return [...new Set(v.filter((x): x is number => typeof x === "number" && known.has(x)))];
}

const status = (v: unknown, fallback: PostStatus): PostStatus => (POST_STATUSES.includes(v as PostStatus) ? (v as PostStatus) : fallback);

async function view(p: Row) {
  const d = await details([p.id]);
  return {
    id: p.id,
    title: p.title,
    impact: p.impact,
    status: p.status,
    author: p.author,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
    resolvedAt: iso(p.resolvedAt),
    pages: d.pages.get(p.id) ?? [],
    monitors: d.monitors.get(p.id) ?? [],
    updates: (d.updates.get(p.id) ?? []).map((u) => updateView(u, true)),
  };
}

const getPost = async (pid: number) => {
  const p = await first<Row>("SELECT * FROM posts WHERE id = ?", pid);
  if (!p) throw new HttpError(404, "Not found");
  return p;
};

postRoutes.get("/", async (c) => {
  const rows = await all<Row>("SELECT * FROM posts ORDER BY resolved_at IS NOT NULL, created_at DESC LIMIT 100");
  return c.json(await Promise.all(rows.map(view)));
});

/** A new post, with its first update. */
postRoutes.post("/", requireCollaborator, async (c) => {
  const b = await body(c);
  const title = str(b.title, 150);
  if (!title) throw bad("A post needs a title");
  const text = str(b.body, 5000);
  if (!text) throw bad("Say what's happening");
  const impact = IMPACTS.includes(b.impact as Row["impact"]) ? (b.impact as Row["impact"]) : "minor";
  const st = status(b.status, "investigating");
  const pages = await ids(b.pages ?? [], "status_pages", "Pages");
  const monitors = await ids(b.monitors ?? [], "monitors", "Monitors");
  const now = Date.now();
  const author = c.get("user").name;
  const { id: pid } = await run(
    "INSERT INTO posts (title, impact, status, author, created_at, updated_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    title,
    impact,
    st,
    author,
    now,
    now,
    st === "resolved" ? now : null,
  );
  await batch([
    ["INSERT INTO post_updates (post_id, status, body, author, created_at) VALUES (?, ?, ?, ?, ?)", pid, st, text, author, now],
    ...pages.map((pg): [string, ...Param[]] => ["INSERT INTO post_pages (post_id, page_id) VALUES (?, ?)", pid, pg]),
    ...monitors.map((m): [string, ...Param[]] => ["INSERT INTO post_monitors (post_id, monitor_id) VALUES (?, ?)", pid, m]),
  ]);
  await refreshPages(c, pages);
  return c.json(await view(await getPost(pid)), 201);
});

/** Title, impact, pages, monitors. The status changes through updates. */
postRoutes.patch("/:id", requireCollaborator, async (c) => {
  const p = await getPost(id(c));
  const b = await body(c);
  const title = b.title !== undefined ? str(b.title, 150) : p.title;
  if (!title) throw bad("A post needs a title");
  const impact = IMPACTS.includes(b.impact as Row["impact"]) ? (b.impact as Row["impact"]) : p.impact;
  const before = (await details([p.id])).pages.get(p.id) ?? [];
  const pages = b.pages !== undefined ? await ids(b.pages, "status_pages", "Pages") : undefined;
  const monitors = b.monitors !== undefined ? await ids(b.monitors, "monitors", "Monitors") : undefined;
  await batch([
    ["UPDATE posts SET title = ?, impact = ?, updated_at = ? WHERE id = ?", title, impact, Date.now(), p.id],
    ...(pages
      ? [["DELETE FROM post_pages WHERE post_id = ?", p.id] as [string, ...Param[]], ...pages.map((pg): [string, ...Param[]] => ["INSERT INTO post_pages (post_id, page_id) VALUES (?, ?)", p.id, pg])]
      : []),
    ...(monitors
      ? [["DELETE FROM post_monitors WHERE post_id = ?", p.id] as [string, ...Param[]], ...monitors.map((m): [string, ...Param[]] => ["INSERT INTO post_monitors (post_id, monitor_id) VALUES (?, ?)", p.id, m])]
      : []),
  ]);
  await refreshPages(c, [...new Set([...before, ...(pages ?? [])])]);
  return c.json(await view(await getPost(p.id)));
});

/** An update on the timeline, which also moves the post's status. */
postRoutes.post("/:id/updates", requireCollaborator, async (c) => {
  const p = await getPost(id(c));
  const b = await body(c);
  const text = str(b.body, 5000);
  if (!text) throw bad("Write the update");
  const st = status(b.status, p.status);
  const now = Date.now();
  await batch([
    ["INSERT INTO post_updates (post_id, status, body, author, created_at) VALUES (?, ?, ?, ?, ?)", p.id, st, text, c.get("user").name, now],
    // Resolving closes it; a new update on a resolved post opens it again.
    ["UPDATE posts SET status = ?, updated_at = ?, resolved_at = ? WHERE id = ?", st, now, st === "resolved" ? (p.resolvedAt ?? now) : null, p.id],
  ]);
  await refreshPages(c, (await details([p.id])).pages.get(p.id) ?? []);
  return c.json(await view(await getPost(p.id)), 201);
});

postRoutes.delete("/:id/updates/:update", requireCollaborator, async (c) => {
  const p = await getPost(id(c));
  const left = await all<UpdateRow>("SELECT * FROM post_updates WHERE post_id = ?", p.id);
  if (left.length <= 1) throw bad("A post keeps at least one update: delete the post instead");
  await run("DELETE FROM post_updates WHERE id = ? AND post_id = ?", id(c, "update"), p.id);
  // The status follows the latest update that's left.
  const latest = await first<UpdateRow>("SELECT * FROM post_updates WHERE post_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", p.id);
  if (latest) await run("UPDATE posts SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN coalesce(resolved_at, ?) ELSE NULL END WHERE id = ?", latest.status, latest.status, latest.createdAt, p.id);
  await refreshPages(c, (await details([p.id])).pages.get(p.id) ?? []);
  return c.json(await view(await getPost(p.id)));
});

postRoutes.delete("/:id", requireCollaborator, async (c) => {
  const p = await getPost(id(c));
  const pages = (await details([p.id])).pages.get(p.id) ?? [];
  await run("DELETE FROM posts WHERE id = ?", p.id);
  await refreshPages(c, pages);
  return c.body(null, 204);
});
