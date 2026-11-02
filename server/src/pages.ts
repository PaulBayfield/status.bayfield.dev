// Public status pages, like Uptime Kuma's: each has an address (/status/<slug>), a title, a
// description, and groups of monitors in a chosen order. One of them is the default page.

import { Hono } from "hono";
import { all, batch, first, run, type Param } from "./db.ts";
import { HttpError, bad, body, id, str } from "./http.ts";
import { requireCollaborator, type AppEnv } from "./auth.ts";
import type { Monitor } from "./checks.ts";
import { daysByMonitor, publicMonitorView } from "./views.ts";
import { forgetPages } from "./public.ts";

interface PageRow {
  id: number;
  slug: string;
  title: string;
  description: string;
  logoUrl: string;
  isDefault: number;
  createdAt: number;
  updatedAt: number;
}

interface GroupRow {
  id: number;
  pageId: number;
  name: string;
  position: number;
}

export interface PageGroup {
  name: string;
  monitors: number[];
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_GROUPS = 30;
const DAY = 24 * 60 * 60_000;

/** The groups of the given pages, with their monitor ids in order. */
async function groupsByPage(pageIds: number[]): Promise<Map<number, PageGroup[]>> {
  const out = new Map<number, PageGroup[]>();
  if (!pageIds.length) return out;
  const marks = pageIds.map(() => "?").join(",");
  const groups = await all<GroupRow>(`SELECT * FROM status_page_groups WHERE page_id IN (${marks}) ORDER BY page_id, position`, ...pageIds);
  const links = await all<{ groupId: number; monitorId: number }>(
    `SELECT l.group_id, l.monitor_id FROM status_page_monitors l JOIN status_page_groups g ON g.id = l.group_id WHERE g.page_id IN (${marks}) ORDER BY l.position`,
    ...pageIds,
  );
  for (const g of groups) {
    const list = out.get(g.pageId) ?? [];
    list.push({ name: g.name, monitors: links.filter((l) => l.groupId === g.id).map((l) => l.monitorId) });
    out.set(g.pageId, list);
  }
  return out;
}

const pageView = (p: PageRow, groups: PageGroup[]) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  description: p.description,
  logoUrl: p.logoUrl,
  isDefault: !!p.isDefault,
  groups,
  updatedAt: new Date(p.updatedAt).toISOString(),
});

/** Which pages show each monitor: listed on the monitor's page in the app. */
export async function pagesByMonitor(): Promise<Map<number, { id: number; slug: string; title: string }[]>> {
  const rows = await all<{ monitorId: number; id: number; slug: string; title: string }>(
    `SELECT DISTINCT l.monitor_id, p.id, p.slug, p.title FROM status_page_monitors l
     JOIN status_page_groups g ON g.id = l.group_id JOIN status_pages p ON p.id = g.page_id ORDER BY p.title`,
  );
  const out = new Map<number, { id: number; slug: string; title: string }[]>();
  for (const { monitorId, ...p } of rows) out.set(monitorId, [...(out.get(monitorId) ?? []), p]);
  return out;
}

/** What a visitor sees of a page: its monitors without targets or errors, and the last week's outages. */
export async function publicPage(slug: string | null) {
  const page = slug
    ? await first<PageRow>("SELECT * FROM status_pages WHERE slug = ?", slug)
    : await first<PageRow>("SELECT * FROM status_pages ORDER BY is_default DESC, id LIMIT 1");
  if (!page) return null;
  const groups = (await groupsByPage([page.id])).get(page.id) ?? [];
  const ids = [...new Set(groups.flatMap((g) => g.monitors))];
  const monitors = ids.length ? await all<Monitor>(`SELECT * FROM monitors WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids) : [];
  const byId = new Map(monitors.map((m) => [m.id, m]));
  const days = await daysByMonitor(ids);
  const incidents = ids.length
    ? await all<{ monitorId: number; startedAt: number; resolvedAt: number | null }>(
        `SELECT monitor_id, started_at, resolved_at FROM incidents WHERE monitor_id IN (${ids.map(() => "?").join(",")}) AND (resolved_at IS NULL OR resolved_at > ?) ORDER BY started_at DESC LIMIT 20`,
        ...ids,
        Date.now() - 7 * DAY,
      )
    : [];
  return {
    slug: page.slug,
    title: page.title,
    description: page.description,
    logoUrl: page.logoUrl,
    updatedAt: new Date().toISOString(),
    groups: groups.map((g) => ({
      name: g.name,
      monitors: g.monitors.flatMap((mid) => {
        const m = byId.get(mid);
        return m ? [publicMonitorView(m, days.get(mid) ?? [])] : [];
      }),
    })),
    // Without their technical cause.
    incidents: incidents.map((i) => ({
      monitorId: i.monitorId,
      monitorName: byId.get(i.monitorId)?.name ?? "",
      startedAt: new Date(i.startedAt).toISOString(),
      resolvedAt: i.resolvedAt ? new Date(i.resolvedAt).toISOString() : null,
    })),
  };
}

// --- The app's routes (signed in) ---

export const pageRoutes = new Hono<AppEnv>();

const getPage = async (pid: number) => {
  const p = await first<PageRow>("SELECT * FROM status_pages WHERE id = ?", pid);
  if (!p) throw new HttpError(404, "Not found");
  return p;
};

async function parseGroups(v: unknown): Promise<PageGroup[]> {
  if (!Array.isArray(v)) throw bad("Groups must be a list");
  if (v.length > MAX_GROUPS) throw bad(`A page has at most ${MAX_GROUPS} groups`);
  const known = new Set((await all<{ id: number }>("SELECT id FROM monitors")).map((m) => m.id));
  return v.map((g) => {
    const o = (g && typeof g === "object" ? g : {}) as Record<string, unknown>;
    const ids = Array.isArray(o.monitors) ? o.monitors.filter((x): x is number => typeof x === "number" && known.has(x)) : [];
    return { name: str(o.name, 80), monitors: [...new Set(ids)] };
  });
}

/** A logo is only a link: an https:// image URL, or empty for the default one. */
function parseLogo(v: unknown): string {
  const raw = str(v, 2000);
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") throw new Error();
    return u.toString();
  } catch {
    throw bad("The logo must be an image URL starting with https://");
  }
}

async function parseSlug(v: unknown, except?: number) {
  const slug = str(v, 64).toLowerCase();
  if (!SLUG.test(slug)) throw bad("The address can use lowercase letters, digits and dashes");
  if (await first("SELECT 1 AS x FROM status_pages WHERE slug = ? AND id <> ?", slug, except ?? 0)) throw new HttpError(409, "Another page already uses this address");
  return slug;
}

/** Replaces a page's groups in one transaction. */
function groupStatements(pid: number, groups: PageGroup[]): [string, ...Param[]][] {
  const out: [string, ...Param[]][] = [["DELETE FROM status_page_groups WHERE page_id = ?", pid]];
  groups.forEach((g, i) => {
    out.push(["INSERT INTO status_page_groups (page_id, name, position) VALUES (?, ?, ?)", pid, g.name, i]);
    g.monitors.forEach((mid, j) => {
      out.push(["INSERT INTO status_page_monitors (group_id, monitor_id, position) VALUES ((SELECT id FROM status_page_groups WHERE page_id = ? AND position = ?), ?, ?)", pid, i, mid, j]);
    });
  });
  return out;
}

export async function listPages() {
  const pages = await all<PageRow>("SELECT * FROM status_pages ORDER BY is_default DESC, lower(title)");
  const groups = await groupsByPage(pages.map((p) => p.id));
  return pages.map((p) => pageView(p, groups.get(p.id) ?? []));
}

pageRoutes.get("/", async (c) => c.json(await listPages()));

pageRoutes.get("/:id", async (c) => {
  const p = await getPage(id(c));
  return c.json(pageView(p, (await groupsByPage([p.id])).get(p.id) ?? []));
});

pageRoutes.post("/", requireCollaborator, async (c) => {
  const b = await body(c);
  const title = str(b.title, 100);
  if (!title) throw bad("A status page needs a title");
  const slug = await parseSlug(b.slug);
  const groups = b.groups === undefined ? [] : await parseGroups(b.groups);
  // The first page is the default one.
  const isDefault = !!b.isDefault || !(await first("SELECT 1 AS x FROM status_pages"));
  const now = Date.now();
  const { id: pid } = await run(
    "INSERT INTO status_pages (slug, title, description, logo_url, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    slug,
    title,
    str(b.description, 1000),
    parseLogo(b.logoUrl),
    isDefault,
    now,
    now,
  );
  await batch([...(isDefault ? [["UPDATE status_pages SET is_default = 0 WHERE id <> ?", pid] as [string, ...Param[]]] : []), ...groupStatements(pid, groups)]);
  c.executionCtx.waitUntil(forgetPages(new URL(c.req.url).origin, [slug]));
  return c.json(pageView(await getPage(pid), groups), 201);
});

pageRoutes.patch("/:id", requireCollaborator, async (c) => {
  const p = await getPage(id(c));
  const b = await body(c);
  const title = b.title !== undefined ? str(b.title, 100) : p.title;
  if (!title) throw bad("A status page needs a title");
  const slug = b.slug !== undefined ? await parseSlug(b.slug, p.id) : p.slug;
  const description = b.description !== undefined ? str(b.description, 1000) : p.description;
  const logoUrl = b.logoUrl !== undefined ? parseLogo(b.logoUrl) : p.logoUrl;
  // There's always a default page: it can be moved to another one, not switched off.
  const isDefault = b.isDefault === true || !!p.isDefault;
  const statements: [string, ...Param[]][] = [
    ["UPDATE status_pages SET title = ?, slug = ?, description = ?, logo_url = ?, is_default = ?, updated_at = ? WHERE id = ?", title, slug, description, logoUrl, isDefault, Date.now(), p.id],
  ];
  if (isDefault) statements.push(["UPDATE status_pages SET is_default = 0 WHERE id <> ?", p.id]);
  if (b.groups !== undefined) statements.push(...groupStatements(p.id, await parseGroups(b.groups)));
  await batch(statements);
  c.executionCtx.waitUntil(forgetPages(new URL(c.req.url).origin, [p.slug, slug]));
  return c.json(pageView(await getPage(p.id), (await groupsByPage([p.id])).get(p.id) ?? []));
});

pageRoutes.delete("/:id", requireCollaborator, async (c) => {
  const p = await getPage(id(c));
  await run("DELETE FROM status_pages WHERE id = ?", p.id);
  c.executionCtx.waitUntil(forgetPages(new URL(c.req.url).origin, [p.slug]));
  // Another page takes over as the default one.
  if (p.isDefault) await run("UPDATE status_pages SET is_default = 1 WHERE id = (SELECT id FROM status_pages ORDER BY id LIMIT 1)");
  return c.body(null, 204);
});
